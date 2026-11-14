// Colecta lifecycle: create, join, propose/vote, evaluate goal, confirm (charges), deadline
// outcomes. No charge exists until the organizer confirms. The default path is all-or-nothing
// (a reached goal). The organizer may also confirm an open colecta with the amount already
// collected; amounts stay frozen at what each person was told under the original goal.
import { newId, newCode } from '../util/ids.js';
import { normalizePhone, chatIdForPhone } from '../util/phone.js';
import { isValidClabe, normalizeClabe } from '../util/clabe.js';
import { resolveAmounts, progress } from './amounts.js';
import { winner, tally, voteOf } from './voting.js';
import { DomainError } from './errors.js';
import { CODI_STATUSES, CHARGE_EXPIRATION_SECONDS, numRefFor } from '../integrations/pey.js';
import { log } from '../logger.js';

export const STATUS = {
  OPEN: 'open',
  GOAL_REACHED: 'goal_reached',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const MILESTONES = [50, 75];
const ACTIVE = new Set([STATUS.OPEN, STATUS.GOAL_REACHED]);

export class ColectaService {
  constructor({ store, notifier, pey, arturito, clock = () => new Date() }) {
    this.store = store;
    this.notifier = notifier;
    this.pey = pey;
    this.arturito = arturito;
    this.clock = clock;
  }

  now() {
    return this.clock().toISOString();
  }

  // ---------- organizer ----------

  async create(organizer, input) {
    const fields = this.validateConfig(input, { requireAll: true });
    const phone = normalizePhone(input.organizerPhone);
    if (!phone) throw new DomainError('Escribe un WhatsApp válido (10 dígitos).');
    const clabe = normalizeClabe(input.clabe);
    if (!isValidClabe(clabe)) throw new DomainError('La CLABE debe tener 18 dígitos válidos.');
    const organizerName = String(input.organizerName || '').trim();
    if (!organizerName) throw new DomainError('Escribe tu nombre.');
    // Register the organizer's own CLABE with Pey before anything is stored: a failed
    // registration must not leave a half-created colecta.
    const code = newCode();
    const account = await this.registerBankAccount({ code, organizerName, clabe });
    if (!account) throw new DomainError('No pudimos registrar tu CLABE con Pey. Intenta de nuevo en unos minutos.', 502, 'pey_bank_account');
    const ts = this.now();
    const colecta = this.store.insert('colectas', {
      id: newId(),
      code,
      organizerId: organizer.id,
      organizerName,
      organizerPhone: phone,
      clabe,
      bankAccountId: account.id,
      codiStatus: account.codiStatus,
      codiStatusUpdatedAt: ts,
      ...fields,
      status: STATUS.OPEN,
      finalGift: null,
      winningProposalId: null,
      votingClosedAt: null,
      confirmedAt: null,
      failedAt: null,
      cancelledAt: null,
      milestonesNotified: [],
      reminderSentAt: null,
      createdAt: ts,
      updatedAt: ts,
    });
    await this.arturito.register({ phone, role: 'organizer', colectaId: colecta.id });
    return colecta;
  }

  // POST /bank-account for an organizer. Returns {id, codiStatus} or null when Pey fails.
  async registerBankAccount({ code, organizerName, clabe }) {
    try {
      const account = await this.pey.createBankAccount({ alias: `Coperacha ${code}`, name: organizerName, clabe, entity: 'PERSON' });
      if (!account?.id) return null;
      return { id: account.id, codiStatus: CODI_STATUSES.has(account.codiStatus) ? account.codiStatus : 'PENDING' };
    } catch (err) {
      log.error('pey.bank_account.register_failed', { error: err?.message });
      return null;
    }
  }

  validateConfig(input, { requireAll = false } = {}) {
    const out = {};
    if (requireAll || input.giftIdea !== undefined) out.giftIdea = String(input.giftIdea || '').trim() || null;
    if (requireAll || input.goalCents !== undefined) {
      if (!Number.isInteger(input.goalCents) || input.goalCents <= 0) throw new DomainError('La meta debe ser un monto mayor a cero.');
      out.goalCents = input.goalCents;
    }
    if (requireAll || input.deadline !== undefined) {
      const d = input.deadline instanceof Date ? input.deadline : new Date(input.deadline);
      if (Number.isNaN(d.getTime())) throw new DomainError('Elige una fecha límite válida.');
      if (d.getTime() <= this.clock().getTime()) throw new DomainError('La fecha límite debe ser en el futuro.');
      out.deadline = d.toISOString();
    }
    if (requireAll || input.splitMode !== undefined) {
      if (!['equal', 'free'].includes(input.splitMode)) throw new DomainError('Elige cómo se reparte.');
      out.splitMode = input.splitMode;
    }
    return out;
  }

  updateConfig(colecta, organizer, input) {
    this.assertOwner(colecta, organizer);
    if (![STATUS.OPEN, STATUS.GOAL_REACHED, STATUS.FAILED].includes(colecta.status)) {
      throw new DomainError('Esta colecta ya no se puede editar.', 409);
    }
    const fields = this.validateConfig(input);
    this.store.update('colectas', colecta.id, { ...fields, updatedAt: this.now() });
    return this.evaluate(colecta.id);
  }

  assertOwner(colecta, organizer) {
    if (!organizer || colecta.organizerId !== organizer.id) throw new DomainError('No tienes acceso a esta colecta.', 403, 'forbidden');
  }

  listForOrganizer(organizer) {
    return this.store.find('colectas', (c) => c.organizerId === organizer.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  byCode(code) {
    return this.store.findOne('colectas', (c) => c.code === code);
  }

  byId(id) {
    return this.store.get('colectas', id);
  }

  // ---------- participants ----------

  participants(colectaId) {
    return this.store.find('participants', (p) => p.colectaId === colectaId).sort((a, b) => (a.joinedAt < b.joinedAt ? -1 : 1));
  }

  async join(colecta, input) {
    if (colecta.status !== STATUS.OPEN && colecta.status !== STATUS.GOAL_REACHED) {
      throw new DomainError('Esta colecta ya no acepta participantes.', 409);
    }
    const name = String(input.name || '').trim();
    if (!name) throw new DomainError('Escribe tu nombre.');
    const phone = normalizePhone(input.phone);
    if (!phone) throw new DomainError('Escribe un WhatsApp válido (10 dígitos).');
    if (this.participants(colecta.id).some((p) => p.phone === phone)) {
      throw new DomainError('Ese WhatsApp ya está en la colecta.', 409, 'duplicate');
    }
    const mode = input.mode;
    const record = { mode, fixedCents: null, capCents: null };
    if (mode === 'fixed') {
      if (colecta.splitMode !== 'free') throw new DomainError('En esta colecta todos ponen lo mismo.');
      if (!Number.isInteger(input.fixedCents) || input.fixedCents <= 0) throw new DomainError('Escribe un monto mayor a cero.');
      record.fixedCents = input.fixedCents;
    } else if (mode === 'majority_cap') {
      if (!Number.isInteger(input.capCents) || input.capCents <= 0) throw new DomainError('Escribe tu máximo.');
      record.capCents = input.capCents;
    } else if (mode !== 'equal') {
      throw new DomainError('Elige cómo quieres participar.');
    }
    const before = this.snapshot(colecta.id);
    const participant = this.store.insert('participants', {
      id: newId(),
      colectaId: colecta.id,
      name,
      phone,
      chatId: chatIdForPhone(phone),
      ...record,
      finalCents: null,
      joinedAt: this.now(),
    });
    await this.arturito.register({ phone, role: 'participant', colectaId: colecta.id });
    const after = this.evaluate(colecta.id);
    await this.notifier.joined(after.colecta, participant, this.amountFor(after, participant));
    await this.notifyMilestones(after, before);
    return participant;
  }

  // Plain values (not store references) of status and progress, for before/after comparisons.
  snapshot(colectaId) {
    const s = this.summary(colectaId);
    return { status: s.colecta.status, percent: s.percent };
  }

  participantByPhone(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) return [];
    return this.store.find('participants', (p) => p.phone === normalized);
  }

  // ---------- amounts and visibility ----------

  summary(colectaId) {
    const colecta = this.byId(colectaId);
    const participants = this.participants(colectaId);
    const resolved = resolveAmounts(colecta.goalCents, participants);
    const totalCents = colecta.status === STATUS.CONFIRMED
      ? participants.reduce((s, p) => s + (p.finalCents ?? 0), 0)
      : resolved.totalCents;
    return {
      colecta,
      participants,
      resolved,
      totalCents,
      participantCount: participants.length,
      ...progress(colecta.goalCents, totalCents),
      contributorsVisible: colecta.status === STATUS.CONFIRMED,
    };
  }

  // Amount a given participant currently owes (provisional before confirmation).
  amountFor(summary, participant) {
    if (participant.finalCents !== null && participant.finalCents !== undefined) return participant.finalCents;
    return summary.resolved.byParticipant.get(participant.id)?.resolvedCents ?? 0;
  }

  // The only place that exposes who-paid-what. Returns null unless the colecta is confirmed.
  contributorList(summary) {
    if (!summary.contributorsVisible) return null;
    return summary.participants.map((p) => ({ name: p.name, amountCents: p.finalCents }));
  }

  // Counts and totals the organizer may see while the colecta runs (no names with amounts).
  organizerStats(summary) {
    const modes = { fixed: 0, equal: 0, majority_cap: 0 };
    for (const p of summary.participants) modes[p.mode]++;
    return {
      participantCount: summary.participantCount,
      totalCents: summary.totalCents,
      remainingCents: summary.remainingCents,
      percent: summary.percent,
      shareCents: summary.resolved.share,
      modes,
      names: summary.participants.map((p) => p.name),
    };
  }

  // ---------- goal evaluation ----------

  evaluate(colectaId) {
    const summary = this.summary(colectaId);
    const { colecta } = summary;
    if (colecta.status === STATUS.OPEN && summary.reached) {
      this.store.update('colectas', colecta.id, { status: STATUS.GOAL_REACHED, updatedAt: this.now() });
    } else if (colecta.status === STATUS.GOAL_REACHED && !summary.reached) {
      this.store.update('colectas', colecta.id, { status: STATUS.OPEN, updatedAt: this.now() });
    }
    return this.summary(colectaId);
  }

  async notifyMilestones(after, before) {
    if (after.colecta.status === STATUS.GOAL_REACHED && before.status !== STATUS.GOAL_REACHED) {
      await this.notifier.goalReached(after.colecta, after);
      return;
    }
    for (const m of MILESTONES) {
      if (after.percent >= m && before.percent < m && !after.colecta.milestonesNotified.includes(m)) {
        this.store.update('colectas', after.colecta.id, { milestonesNotified: [...after.colecta.milestonesNotified, m] });
        await this.notifier.milestone(after.colecta, m, after);
      }
    }
  }

  // Organizer confirms: amounts freeze and CoDi charges go out. The default path requires a
  // reached goal. With acceptBelowGoal, an open colecta can be confirmed at the current
  // committed total; amounts are frozen first against the original goal, so nobody pays more
  // than they were told, then the goal is lowered to that total.
  async confirm(colecta, organizer, { acceptBelowGoal = false } = {}) {
    this.assertOwner(colecta, organizer);
    const summary = this.evaluate(colecta.id);
    const belowGoal = summary.colecta.status === STATUS.OPEN && acceptBelowGoal;
    if (belowGoal) {
      if (summary.participantCount < 1 || summary.totalCents <= 0) {
        throw new DomainError('Todavía no hay aportaciones para confirmar.', 409, 'no_participants');
      }
    } else if (summary.colecta.status !== STATUS.GOAL_REACHED) {
      throw new DomainError('Todavía no se llega a la meta.', 409, 'goal_not_reached');
    }
    if (summary.colecta.codiStatus !== 'ACTIVE' || !summary.colecta.bankAccountId) {
      throw new DomainError('Los cobros CoDi salen cuando Pey active tu cuenta. Te avisamos por WhatsApp en cuanto quede lista.', 409, 'bank_account_not_active');
    }
    const ts = this.now();
    // Freeze amounts against the current (original) goal before any goal change.
    for (const p of summary.participants) {
      this.store.update('participants', p.id, { finalCents: this.amountFor(summary, p) });
    }
    const patch = { status: STATUS.CONFIRMED, confirmedAt: ts, updatedAt: ts };
    if (belowGoal) {
      patch.originalGoalCents = summary.colecta.goalCents;
      patch.confirmedBelowGoal = true;
      patch.goalCents = summary.totalCents;
    }
    this.store.update('colectas', colecta.id, patch);
    const confirmed = this.summary(colecta.id);
    if (belowGoal) await this.notifier.confirmedBelowGoal(confirmed.colecta, confirmed);
    const expiresAt = new Date(this.clock().getTime() + CHARGE_EXPIRATION_SECONDS * 1000).toISOString();
    const charges = [];
    for (const p of confirmed.participants) {
      const reference = `CP-${colecta.code}-${p.id.slice(0, 8)}`;
      const sent = await this.sendCharge({
        amountCents: p.finalCents,
        concept: `Coperacha ${colecta.finalGift || colecta.giftIdea || colecta.code}`.slice(0, 40),
        expirationSeconds: CHARGE_EXPIRATION_SECONDS,
        numRef: numRefFor(reference),
        bankAccountId: confirmed.colecta.bankAccountId,
        metadata: { reference, colecta: colecta.code, participant: p.id },
      }, p.phone);
      const charge = this.store.insert('charges', {
        id: newId(),
        colectaId: colecta.id,
        participantId: p.id,
        peyTransactionId: sent.transactionId,
        codiId: sent.codiId,
        method: sent.method,
        qrString: sent.qrString,
        reference,
        amountCents: p.finalCents,
        // 'failed' is local only: Pey accepted neither the push nor the QR request.
        status: sent.method ? 'pending' : 'failed',
        expiresAt,
        createdAt: ts,
        updatedAt: ts,
      });
      charges.push(charge);
      if (sent.method) await this.notifier.charge(confirmed.colecta, p, charge);
    }
    return { summary: confirmed, charges };
  }

  // CoDi push notification first; QR as the fallback when the push cannot be created.
  async sendCharge(request, phone) {
    const reference = request.metadata.reference;
    try {
      const pn = await this.pey.createPushCharge({ ...request, phone });
      if (pn?.transactionId) return { method: 'pn', transactionId: pn.transactionId, codiId: pn.codiId || null, qrString: null };
    } catch (err) {
      log.warn('pey.charge.pn_failed', { reference, error: err?.message });
    }
    try {
      const qr = await this.pey.createQrCharge(request);
      if (qr?.qrString) return { method: 'qr', transactionId: qr.transactionId || null, codiId: qr.codiId || null, qrString: qr.qrString };
    } catch (err) {
      log.error('pey.charge.qr_failed', { reference, error: err?.message });
    }
    return { method: null, transactionId: null, codiId: null, qrString: null };
  }

  charges(colectaId) {
    return this.store.find('charges', (c) => c.colectaId === colectaId);
  }

  // payment_received: marks the matching local charge paid. Unknown ids return null.
  applyPaymentEvent({ transactionId, metadata = null }) {
    const charge = this.store.findOne('charges', (c) => (transactionId && c.peyTransactionId === transactionId)
      || (metadata?.reference && c.reference === metadata.reference));
    if (!charge) return null;
    if (charge.status === 'paid') return charge;
    return this.store.update('charges', charge.id, { status: 'paid', updatedAt: this.now() });
  }

  // Persists a new codiStatus on every colecta that uses the account and tells the
  // organizer when it becomes ACTIVE. Returns the colectas that use the account.
  async applyBankAccountStatus(bankAccountId, codiStatus) {
    if (!bankAccountId || !CODI_STATUSES.has(codiStatus)) return [];
    const matches = this.store.find('colectas', (c) => c.bankAccountId === bankAccountId);
    for (const c of matches) {
      if (c.codiStatus === codiStatus) continue;
      const ts = this.now();
      this.store.update('colectas', c.id, { codiStatus, codiStatusUpdatedAt: ts, updatedAt: ts });
      if (codiStatus === 'ACTIVE' && ACTIVE.has(c.status)) {
        await this.notifier.bankAccountActive(this.byId(c.id), this.summary(c.id));
      }
    }
    return matches;
  }

  // Entry point for a verified Pey webhook. Deduplicates on the webhook id: a replay is a
  // no-op. `known` says whether the event matched something of ours.
  async handlePeyEvent(event) {
    if (this.store.get('webhookEvents', event.id)) return { known: false, duplicate: true };
    let known = false;
    if (event.type === 'payment') known = Boolean(this.applyPaymentEvent(event));
    else if (event.type === 'bank_account') known = (await this.applyBankAccountStatus(event.bankAccountId, event.codiStatus)).length > 0;
    this.store.insert('webhookEvents', { id: event.id, event: event.event, receivedAt: this.now() });
    return { known, duplicate: false };
  }

  // Periodic Pey upkeep; idempotent. With `poll` it asks Pey about accounts that are not
  // active yet and about pending transactions (and registers the CLABE of colectas created
  // before bank accounts existed). Always: a charge still pending after its expiration is
  // marked expired here, because Pey sends no failed/expired events.
  async sweepPey(now = this.clock(), { poll = true } = {}) {
    const nowMs = now.getTime();
    const results = { activated: [], paid: [], expired: [] };
    if (poll) {
      for (const c of this.store.find('colectas', (c) => ACTIVE.has(c.status) && c.codiStatus !== 'ACTIVE' && c.codiStatus !== 'ERROR')) {
        try {
          let next;
          if (c.bankAccountId) {
            next = (await this.pey.getBankAccount(c.bankAccountId)).codiStatus;
          } else {
            const account = await this.registerBankAccount({ code: c.code, organizerName: c.organizerName, clabe: c.clabe });
            if (!account) continue;
            this.store.update('colectas', c.id, { bankAccountId: account.id, updatedAt: now.toISOString() });
            next = account.codiStatus;
            await this.applyBankAccountStatus(account.id, next);
            if (this.byId(c.id).codiStatus === 'ACTIVE') results.activated.push(c.id);
            continue;
          }
          await this.applyBankAccountStatus(c.bankAccountId, next);
          if (this.byId(c.id).codiStatus === 'ACTIVE') results.activated.push(c.id);
        } catch (err) {
          log.warn('pey.bank_account.poll_failed', { colectaId: c.id, error: err?.message });
        }
      }
    }
    for (const ch of this.store.find('charges', (ch) => ch.status === 'pending')) {
      try {
        if (poll && ch.peyTransactionId) {
          const tx = await this.pey.getTransaction(ch.peyTransactionId);
          if (tx.status === 'PAID') {
            this.store.update('charges', ch.id, { status: 'paid', updatedAt: now.toISOString() });
            results.paid.push(ch.id);
            continue;
          }
        }
        if (ch.expiresAt && new Date(ch.expiresAt).getTime() <= nowMs) {
          this.store.update('charges', ch.id, { status: 'expired', updatedAt: now.toISOString() });
          results.expired.push(ch.id);
        }
      } catch (err) {
        log.warn('pey.transaction.poll_failed', { chargeId: ch.id, error: err?.message });
      }
    }
    const cutoff = nowMs - 30 * 864e5;
    for (const e of this.store.find('webhookEvents', (e) => new Date(e.receivedAt).getTime() < cutoff)) {
      this.store.remove('webhookEvents', e.id);
    }
    return results;
  }

  // ---------- deadline ----------

  // Marks open colectas past their deadline as failed (nobody is charged) and sends the
  // 24-hour reminder. Idempotent; meant to run periodically and in tests.
  async sweepDeadlines(now = this.clock()) {
    const nowMs = now.getTime();
    const results = { failed: [], reminded: [] };
    for (const c of this.store.find('colectas', (c) => ACTIVE.has(c.status))) {
      const deadlineMs = new Date(c.deadline).getTime();
      if (c.status === STATUS.OPEN && deadlineMs <= nowMs) {
        const summary = this.evaluate(c.id);
        if (summary.reached) continue;
        const ts = now.toISOString();
        this.store.update('colectas', c.id, { status: STATUS.FAILED, failedAt: ts, updatedAt: ts });
        await this.notifier.deadlineMissed(this.byId(c.id), summary);
        results.failed.push(c.id);
        continue;
      }
      const hoursLeft = (deadlineMs - nowMs) / 36e5;
      if (!c.reminderSentAt && hoursLeft > 0 && hoursLeft <= 24 && c.status === STATUS.OPEN) {
        this.store.update('colectas', c.id, { reminderSentAt: now.toISOString() });
        await this.notifier.deadlineReminder(this.byId(c.id), this.summary(c.id));
        results.reminded.push(c.id);
      }
    }
    return results;
  }

  // Outcomes after a missed deadline. Each one is the organizer's explicit choice.
  async changeGift(colecta, organizer, { giftIdea, deadline }) {
    this.assertOwner(colecta, organizer);
    this.assertFailed(colecta);
    const fields = this.validateConfig({ giftIdea, deadline });
    if (!fields.giftIdea) throw new DomainError('Escribe el nuevo regalo.');
    this.store.update('colectas', colecta.id, {
      ...fields, status: STATUS.OPEN, failedAt: null, reminderSentAt: null, finalGift: null,
      winningProposalId: null, votingClosedAt: null, updatedAt: this.now(),
    });
    const summary = this.evaluate(colecta.id);
    await this.notifier.reopened(summary.colecta, summary, 'gift');
    return summary;
  }

  async lowerGoal(colecta, organizer, { goalCents, deadline }) {
    this.assertOwner(colecta, organizer);
    this.assertFailed(colecta);
    if (!Number.isInteger(goalCents) || goalCents <= 0 || goalCents >= colecta.goalCents) {
      throw new DomainError('La nueva meta debe ser menor a la actual.');
    }
    const current = this.summary(colecta.id);
    const patch = { goalCents, status: STATUS.OPEN, failedAt: null, reminderSentAt: null, updatedAt: this.now() };
    if (current.totalCents < goalCents) {
      if (!deadline) throw new DomainError('Con esa meta todavía falta: elige una nueva fecha límite.');
      Object.assign(patch, this.validateConfig({ deadline }));
    }
    this.store.update('colectas', colecta.id, patch);
    const summary = this.evaluate(colecta.id);
    if (summary.colecta.status === STATUS.GOAL_REACHED) await this.notifier.goalReached(summary.colecta, summary);
    else await this.notifier.reopened(summary.colecta, summary, 'goal');
    return summary;
  }

  async cancel(colecta, organizer) {
    this.assertOwner(colecta, organizer);
    if (!ACTIVE.has(colecta.status) && colecta.status !== STATUS.FAILED) {
      throw new DomainError('Esta colecta no se puede cancelar.', 409);
    }
    const ts = this.now();
    this.store.update('colectas', colecta.id, { status: STATUS.CANCELLED, cancelledAt: ts, updatedAt: ts });
    const summary = this.summary(colecta.id);
    await this.notifier.cancelled(summary.colecta, summary);
    return summary;
  }

  assertFailed(colecta) {
    if (colecta.status !== STATUS.FAILED) throw new DomainError('Esta opción solo aplica cuando venció la fecha límite.', 409);
  }

  // ---------- proposals and votes ----------

  proposals(colectaId) {
    return this.store.find('proposals', (p) => p.colectaId === colectaId).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  votes(colectaId) {
    return this.store.find('votes', (v) => v.colectaId === colectaId);
  }

  votingOpen(colecta) {
    return ACTIVE.has(colecta.status) && !colecta.votingClosedAt;
  }

  propose(colecta, voterKey, title) {
    if (!this.votingOpen(colecta)) throw new DomainError('La votación ya está cerrada.', 409);
    const clean = String(title || '').trim().slice(0, 120);
    if (!clean) throw new DomainError('Escribe tu propuesta.');
    return this.store.insert('proposals', {
      id: newId(), colectaId: colecta.id, title: clean, proposedBy: voterKey, createdAt: this.now(),
    });
  }

  vote(colecta, voterKey, proposalId) {
    if (!this.votingOpen(colecta)) throw new DomainError('La votación ya está cerrada.', 409);
    const proposal = this.store.get('proposals', proposalId);
    if (!proposal || proposal.colectaId !== colecta.id) throw new DomainError('Esa opción no existe.', 404);
    const existing = voteOf(this.votes(colecta.id), voterKey);
    if (existing) return this.store.update('votes', existing.id, { proposalId, updatedAt: this.now() });
    return this.store.insert('votes', { id: newId(), colectaId: colecta.id, voter: voterKey, proposalId, updatedAt: this.now() });
  }

  votingBoard(colectaId) {
    const proposals = this.proposals(colectaId);
    const votes = this.votes(colectaId);
    const counts = tally(proposals, votes);
    return { proposals: proposals.map((p) => ({ ...p, votes: counts.get(p.id) })), votes, leader: winner(proposals, votes) };
  }

  // Organizer closes voting with the current winner or their own pick.
  async closeVoting(colecta, organizer, { proposalId = null, ownPick = null } = {}) {
    this.assertOwner(colecta, organizer);
    if (!this.votingOpen(colecta)) throw new DomainError('La votación ya está cerrada.', 409);
    let finalGift;
    let winningProposalId = null;
    if (ownPick && String(ownPick).trim()) {
      finalGift = String(ownPick).trim().slice(0, 120);
    } else {
      const board = this.votingBoard(colecta.id);
      const chosen = proposalId ? board.proposals.find((p) => p.id === proposalId) : board.leader;
      if (!chosen) throw new DomainError('No hay propuestas: escribe tu elección.');
      finalGift = chosen.title;
      winningProposalId = chosen.id;
    }
    const ts = this.now();
    this.store.update('colectas', colecta.id, { finalGift, winningProposalId, votingClosedAt: ts, updatedAt: ts });
    const summary = this.summary(colecta.id);
    await this.notifier.giftChosen(summary.colecta, summary);
    return summary;
  }
}
