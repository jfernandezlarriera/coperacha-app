import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSystem, makeColecta, join, events, CLABE } from './helpers.js';
import { DomainError } from '../src/domain/errors.js';

test('create validates CLABE, phone and future deadline; registers organizer with Arturito', async () => {
  const sys = makeSystem();
  await assert.rejects(makeColecta(sys, { clabe: '123' }), /CLABE/);
  await assert.rejects(makeColecta(sys, { clabe: CLABE.slice(0, 17) + ((Number(CLABE[17]) + 1) % 10) }), /CLABE/);
  await assert.rejects(makeColecta(sys, { organizerPhone: '12' }), /WhatsApp/);
  await assert.rejects(makeColecta(sys, { deadline: new Date('2020-01-01') }), /futuro/);
  const c = await makeColecta(sys);
  assert.match(c.code, /^[A-Za-z0-9_-]{8}$/);
  assert.equal(c.status, 'open');
  assert.deepEqual(sys.arturito.registrations[0], {
    phone: '525512345678', role: 'organizer', colectaId: c.id,
    chatIds: ['5215512345678@s.whatsapp.net', '525512345678@s.whatsapp.net'],
  });
});

test('all-or-nothing: no charge until goal reached and organizer confirms', async () => {
  const sys = makeSystem();
  const c = await makeColecta(sys, { goalCents: 60000 });
  await join(sys, c, { mode: 'fixed', fixedCents: 20000 });
  await join(sys, c, { mode: 'fixed', fixedCents: 20000 });
  assert.equal(sys.service.byId(c.id).status, 'open');
  await assert.rejects(sys.service.confirm(sys.service.byId(c.id), sys.organizer), /meta/);
  assert.equal(sys.pey.charges.length, 0);
  await join(sys, c, { mode: 'fixed', fixedCents: 20000 });
  assert.equal(sys.service.byId(c.id).status, 'goal_reached');
  assert.equal(events(sys, 'goalReached').length, 1);
  assert.equal(sys.pey.charges.length, 0, 'goal reached alone does not charge');
  await assert.rejects(sys.service.confirm(sys.service.byId(c.id), sys.other), /acceso/);
  const { charges } = await sys.service.confirm(sys.service.byId(c.id), sys.organizer);
  assert.equal(charges.length, 3);
  assert.equal(sys.pey.charges.length, 3);
  assert.ok(sys.pey.charges.every((ch) => ch.beneficiaryClabe === CLABE && ch.amountCents === 20000));
  assert.equal(events(sys, 'charge').length, 3);
  assert.equal(sys.service.byId(c.id).status, 'confirmed');
  const paid = sys.service.applyPaymentEvent({ chargeId: charges[0].peyChargeId, status: 'paid' });
  assert.equal(paid.status, 'paid');
  assert.equal(sys.service.applyPaymentEvent({ chargeId: 'nope', status: 'paid' }), null);
});

test('contributor list is hidden until confirmed; organizer sees counts, not amounts per name', async () => {
  const sys = makeSystem();
  const c = await makeColecta(sys, { goalCents: 40000 });
  await join(sys, c, { name: 'Luis', mode: 'fixed', fixedCents: 25000 });
  await join(sys, c, { name: 'Mar', mode: 'majority_cap', capCents: 10000 });
  let s = sys.service.summary(c.id);
  assert.equal(sys.service.contributorList(s), null);
  const stats = sys.service.organizerStats(s);
  assert.deepEqual(stats.names, ['Luis', 'Mar']);
  assert.equal(stats.participantCount, 2);
  assert.ok(!('capCents' in stats) && !JSON.stringify(stats).includes('10000'));
  await join(sys, c, { name: 'Sol', mode: 'fixed', fixedCents: 25000 });
  s = sys.service.summary(c.id);
  assert.equal(s.colecta.status, 'goal_reached');
  assert.equal(sys.service.contributorList(s), null, 'still hidden before confirmation');
  await sys.service.confirm(s.colecta, sys.organizer);
  const list = sys.service.contributorList(sys.service.summary(c.id));
  assert.deepEqual(list, [{ name: 'Luis', amountCents: 25000 }, { name: 'Mar', amountCents: 10000 }, { name: 'Sol', amountCents: 25000 }]);
});

test('equal-share amounts move as people join; majority-cap is frozen at confirmation', async () => {
  const sys = makeSystem();
  const c = await makeColecta(sys, { goalCents: 90000, splitMode: 'equal' });
  const a = await join(sys, c, { mode: 'equal' });
  assert.equal(sys.service.amountFor(sys.service.summary(c.id), a), 90000);
  await join(sys, c, { mode: 'equal' });
  assert.equal(sys.service.amountFor(sys.service.summary(c.id), a), 45000);
  await assert.rejects(join(sys, c, { mode: 'fixed', fixedCents: 100 }), /lo mismo/);
  const capped = await join(sys, c, { mode: 'majority_cap', capCents: 20000 });
  let s = sys.service.summary(c.id);
  assert.equal(s.resolved.share, 30000);
  assert.equal(sys.service.amountFor(s, capped), 20000);
  assert.equal(s.totalCents, 80000);
  assert.equal(s.colecta.status, 'open');
  await join(sys, c, { mode: 'equal' });
  s = sys.service.summary(c.id);
  assert.equal(s.resolved.share, 22500);
  assert.equal(s.totalCents, 22500 * 3 + 20000);
  assert.equal(s.colecta.status, 'open');
  const extra = await join(sys, c, { mode: 'equal' });
  s = sys.service.summary(c.id);
  assert.equal(s.totalCents, 18000 * 4 + 18000);
  assert.equal(s.colecta.status, 'goal_reached');
  await sys.service.confirm(s.colecta, sys.organizer);
  const p = sys.store.get('participants', capped.id);
  assert.equal(p.finalCents, 18000);
  assert.equal(sys.store.get('participants', extra.id).finalCents, 18000);
});

test('duplicate phone and closed colectas reject joins; joined notification goes out', async () => {
  const sys = makeSystem();
  const c = await makeColecta(sys);
  await join(sys, c, { phone: '55 5999 0000' });
  await assert.rejects(join(sys, c, { phone: '5559990000' }), /ya está/);
  await assert.rejects(join(sys, c, { phone: '+52 1 55 5999 0000' }), /ya está/);
  assert.equal(events(sys, 'joined').length, 1);
  await sys.service.cancel(sys.service.byId(c.id), sys.organizer);
  await assert.rejects(join(sys, c, {}), /no acepta/);
});

test('voting: one vote per person, re-voting replaces, ties go to the earliest proposal', async () => {
  const sys = makeSystem();
  const c = await makeColecta(sys);
  const a = await join(sys, c, {});
  const b = await join(sys, c, {});
  const p1 = sys.service.propose(c, `p:${a.id}`, 'Bocina');
  const p2 = sys.service.propose(c, `p:${b.id}`, 'Libro');
  sys.service.vote(c, `p:${a.id}`, p1.id);
  sys.service.vote(c, `p:${b.id}`, p2.id);
  let board = sys.service.votingBoard(c.id);
  assert.equal(board.leader.id, p1.id, 'tie -> earliest');
  sys.service.vote(c, `p:${a.id}`, p2.id);
  board = sys.service.votingBoard(c.id);
  assert.equal(board.votes.length, 2);
  assert.equal(board.proposals.find((p) => p.id === p2.id).votes, 2);
  assert.equal(board.leader.id, p2.id);
  assert.throws(() => sys.service.vote(c, `p:${a.id}`, 'missing'), DomainError);
  await assert.rejects(sys.service.closeVoting(c, sys.other), /acceso/);
  const s = await sys.service.closeVoting(c, sys.organizer);
  assert.equal(s.colecta.finalGift, 'Libro');
  assert.equal(s.colecta.winningProposalId, p2.id);
  assert.throws(() => sys.service.propose(sys.service.byId(c.id), `p:${a.id}`, 'Tarde'), /cerrada/);
  assert.equal(events(sys, 'giftChosen').length, 1);
});

test('organizer can close voting with their own pick', async () => {
  const sys = makeSystem();
  const c = await makeColecta(sys);
  const s = await sys.service.closeVoting(c, sys.organizer, { ownPick: 'Cena sorpresa' });
  assert.equal(s.colecta.finalGift, 'Cena sorpresa');
  assert.equal(s.colecta.winningProposalId, null);
});

test('deadline: reminder 24h before, failure after; nobody is charged', async () => {
  const sys = makeSystem();
  const c = await makeColecta(sys, { goalCents: 50000, deadline: new Date(sys.clock().getTime() + 48 * 36e5) });
  await join(sys, c, { mode: 'fixed', fixedCents: 10000 });
  let r = await sys.service.sweepDeadlines();
  assert.deepEqual(r, { failed: [], reminded: [] });
  sys.clock.advanceHours(30);
  r = await sys.service.sweepDeadlines();
  assert.deepEqual(r.reminded, [c.id]);
  assert.equal(events(sys, 'deadlineReminder').length, 1);
  assert.deepEqual((await sys.service.sweepDeadlines()).reminded, [], 'reminder is sent once');
  sys.clock.advanceHours(19);
  r = await sys.service.sweepDeadlines();
  assert.deepEqual(r.failed, [c.id]);
  assert.equal(sys.service.byId(c.id).status, 'failed');
  assert.equal(events(sys, 'deadlineMissed').length, 1);
  assert.equal(sys.pey.charges.length, 0);
  assert.deepEqual((await sys.service.sweepDeadlines()).failed, [], 'idempotent');
});

test('deadline passes with goal reached: stays goal_reached and can be confirmed', async () => {
  const sys = makeSystem();
  const c = await makeColecta(sys, { goalCents: 10000, deadline: new Date(sys.clock().getTime() + 2 * 36e5) });
  await join(sys, c, { mode: 'fixed', fixedCents: 10000 });
  sys.clock.advanceHours(3);
  await sys.service.sweepDeadlines();
  assert.equal(sys.service.byId(c.id).status, 'goal_reached');
  await sys.service.confirm(sys.service.byId(c.id), sys.organizer);
  assert.equal(sys.service.byId(c.id).status, 'confirmed');
});

test('failure outcomes: change gift, lower goal, cancel', async () => {
  const sys = makeSystem();
  const fail = async (goalCents = 50000) => {
    const c = await makeColecta(sys, { goalCents, deadline: new Date(sys.clock().getTime() + 36e5) });
    await join(sys, c, { mode: 'fixed', fixedCents: 20000 });
    sys.clock.advanceHours(2);
    await sys.service.sweepDeadlines();
    return sys.service.byId(c.id);
  };
  // Outcomes only apply to failed colectas.
  const live = await makeColecta(sys);
  await assert.rejects(sys.service.changeGift(live, sys.organizer, { giftIdea: 'X', deadline: new Date(sys.clock().getTime() + 36e5) }), /venció/);

  const c1 = await fail();
  const later = new Date(sys.clock().getTime() + 3 * 864e5);
  await assert.rejects(sys.service.changeGift(c1, sys.organizer, { giftIdea: '', deadline: later }), /regalo/);
  const s1 = await sys.service.changeGift(c1, sys.organizer, { giftIdea: 'Libro', deadline: later });
  assert.equal(s1.colecta.status, 'open');
  assert.equal(s1.colecta.giftIdea, 'Libro');
  assert.equal(s1.colecta.failedAt, null);
  assert.equal(events(sys, 'reopened').at(-1).args[2], 'gift');

  const c2 = await fail();
  await assert.rejects(sys.service.lowerGoal(c2, sys.organizer, { goalCents: 60000 }), /menor/);
  await assert.rejects(sys.service.lowerGoal(c2, sys.organizer, { goalCents: 30000 }), /fecha/);
  const s2 = await sys.service.lowerGoal(c2, sys.organizer, { goalCents: 20000 });
  assert.equal(s2.colecta.status, 'goal_reached', 'lowering to the committed total reaches the goal immediately');
  const c3 = await fail();
  const s3 = await sys.service.lowerGoal(c3, sys.organizer, { goalCents: 30000, deadline: later });
  assert.equal(s3.colecta.status, 'open');

  const c4 = await fail();
  const s4 = await sys.service.cancel(c4, sys.organizer);
  assert.equal(s4.colecta.status, 'cancelled');
  assert.equal(events(sys, 'cancelled').length, 1);
  await assert.rejects(sys.service.cancel(sys.service.byId(c4.id), sys.organizer), /no se puede/);
  assert.equal(sys.pey.charges.length, 0, 'nobody charged across all failure paths');
});

test('updateConfig re-evaluates the goal and refuses closed colectas', async () => {
  const sys = makeSystem();
  const c = await makeColecta(sys, { goalCents: 50000 });
  await join(sys, c, { mode: 'fixed', fixedCents: 30000 });
  const s = sys.service.updateConfig(sys.service.byId(c.id), sys.organizer, { goalCents: 30000 });
  assert.equal(s.colecta.status, 'goal_reached');
  const back = sys.service.updateConfig(sys.service.byId(c.id), sys.organizer, { goalCents: 80000 });
  assert.equal(back.colecta.status, 'open');
  await sys.service.cancel(sys.service.byId(c.id), sys.organizer);
  assert.throws(() => sys.service.updateConfig(sys.service.byId(c.id), sys.organizer, { goalCents: 1 }), /editar/);
});

test('milestones notify the organizer once at 50% and 75%', async () => {
  const sys = makeSystem();
  const c = await makeColecta(sys, { goalCents: 100000 });
  await join(sys, c, { mode: 'fixed', fixedCents: 50000 });
  await join(sys, c, { mode: 'fixed', fixedCents: 10000 });
  await join(sys, c, { mode: 'fixed', fixedCents: 20000 });
  assert.deepEqual(events(sys, 'milestone').map((e) => e.args[1]), [50, 75]);
});

test('messages never use forbidden words', async () => {
  const { messages } = await import('../src/domain/messages.js');
  const text = JSON.stringify(Object.values(messages).map((m) => (typeof m === 'function' ? m.toString() : m)));
  assert.doesNotMatch(text, /inversi[oó]n|rendimiento/i);
});
