// HTTP routes: organizer auth, dashboard, colecta management, participant join/menu,
// Arturito and Pey webhooks.
import crypto from 'node:crypto';
import { Router, createServer } from './router.js';
import * as views from './views.js';
import { encodeSigned, decodeSigned } from '../util/cookies.js';
import { parsePesos } from '../util/money.js';
import { zonedToUtc } from '../util/time.js';
import { waMeLink } from '../util/phone.js';
import { DomainError } from '../domain/errors.js';
import { upsertOrganizer, newState } from '../auth/google.js';
import { PeyWebhookError } from '../integrations/pey.js';
import { log } from '../logger.js';
import { validateContact, RateLimiter, clientIp, buildContactEmail } from './contact.js';

const SESSION_COOKIE = 'cp_session';
const PARTICIPANT_COOKIE = 'cp_participant';
const WEEK = 7 * 24 * 3600;

function bearerOk(header, expected) {
  if (!expected) return false;
  const token = (header || '').startsWith('Bearer ') ? header.slice(7) : '';
  return token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export function buildApp({ config, store, service, inbound, pey, googleAuth, queue, mailer, contactLimiter = new RateLimiter() }) {
  const router = new Router();
  const secret = config.sessionSecret;
  const authDev = config.authDevLogin;

  // ----- helpers -----
  const session = (ctx) => decodeSigned(ctx.cookies[SESSION_COOKIE], secret) || {};
  const currentOrganizer = (ctx) => {
    const s = session(ctx);
    return s.organizerId ? store.get('organizers', s.organizerId) : null;
  };
  const requireOrganizer = (ctx) => {
    const o = currentOrganizer(ctx);
    if (!o) { ctx.redirect('/?next=' + encodeURIComponent(ctx.url.pathname)); return null; }
    return o;
  };
  const signIn = (ctx, organizer) => ctx.setCookie(SESSION_COOKIE, encodeSigned({ organizerId: organizer.id }, secret), { maxAge: WEEK });
  const participantMap = (ctx) => decodeSigned(ctx.cookies[PARTICIPANT_COOKIE], secret) || {};
  const currentParticipant = (ctx, colecta) => {
    const id = participantMap(ctx)[colecta.id];
    const p = id ? store.get('participants', id) : null;
    return p && p.colectaId === colecta.id ? p : null;
  };
  const rememberParticipant = (ctx, colecta, participant) => {
    const map = { ...participantMap(ctx), [colecta.id]: participant.id };
    ctx.setCookie(PARTICIPANT_COOKIE, encodeSigned(map, secret), { maxAge: 90 * 24 * 3600 });
  };
  const ownedColecta = (ctx, organizer) => {
    const c = service.byId(ctx.params.id);
    if (!c || c.organizerId !== organizer.id) throw new DomainError('No encontramos esa colecta.', 404);
    return c;
  };
  const parseConfigForm = (body, { partial = false } = {}) => {
    const out = {};
    if (!partial || body.giftIdea !== undefined) out.giftIdea = body.giftIdea;
    if (!partial || body.goal !== undefined) {
      const goalCents = parsePesos(body.goal);
      if (goalCents === null) throw new DomainError('Escribe la meta en pesos, por ejemplo 1500 o 1500.50.');
      out.goalCents = goalCents;
    }
    if (!partial || body.deadline !== undefined) {
      const deadline = zonedToUtc(body.deadline, config.timezone);
      if (!deadline) throw new DomainError('Elige una fecha límite válida.');
      out.deadline = deadline;
    }
    if (!partial || body.splitMode !== undefined) out.splitMode = body.splitMode;
    return out;
  };
  const shareLink = (colecta) => `${config.baseUrl}/c/${colecta.code}`;
  const whatsappLink = (colecta) => {
    const text = `Hola Coperacha, quiero sumarme a la colecta ${colecta.code}: ${shareLink(colecta)}`;
    return config.arturito.phone ? waMeLink(config.arturito.phone, text) : `https://wa.me/?text=${encodeURIComponent(text)}`;
  };
  const renderOrganizer = (ctx, organizer, colecta, { msg, err } = {}) => {
    const summary = service.summary(colecta.id);
    const board = service.votingBoard(colecta.id);
    const myVote = board.votes.find((v) => v.voter === `o:${organizer.id}`)?.proposalId || null;
    return ctx.send(err ? 400 : 200, views.organizerColectaPage({
      organizer, summary, stats: service.organizerStats(summary), board, myVote,
      link: shareLink(colecta), waLink: whatsappLink(colecta), charges: service.charges(colecta.id),
      contributors: service.contributorList(summary), msg, err, authDev,
      confirmBelow: ctx.query.confirmBelow === '1',
    }));
  };
  const renderParticipant = (ctx, colecta, participant, { msg, err } = {}) => {
    const summary = service.summary(colecta.id);
    const board = service.votingBoard(colecta.id);
    const myVote = board.votes.find((v) => v.voter === `p:${participant.id}`)?.proposalId || null;
    return ctx.send(err ? 400 : 200, views.participantMenuPage({
      colecta: summary.colecta, summary, participant, amountCents: service.amountFor(summary, participant), board, myVote,
      contributors: service.contributorList(summary), msg, err,
    }));
  };

  // ----- public -----
  // App Runner health check. Deliberately independent of S3 so a storage hiccup does not
  // restart the instance (and lose what is waiting to be uploaded).
  router.get('/health', (ctx) => ctx.json(200, { ok: true }));
  router.get('/healthz',(ctx) => ctx.json(200, { ok: true, queue: queue?.size ?? 0 }));
  router.get('/', (ctx) => ctx.send(200, views.homePage({ organizer: currentOrganizer(ctx), authDev })));

  // ----- auth -----
  router.get('/auth/google', (ctx) => {
    if (!googleAuth.enabled) return ctx.send(503, views.errorPage(503, 'Google no está configurado. Define GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y GOOGLE_REDIRECT_URI.'));
    const state = newState();
    ctx.setCookie('cp_oauth_state', encodeSigned({ state }, secret), { maxAge: 600 });
    ctx.redirect(googleAuth.authorizeUrl(state));
  });
  router.get('/auth/google/callback', async (ctx) => {
    const expected = decodeSigned(ctx.cookies.cp_oauth_state, secret)?.state;
    ctx.clearCookie('cp_oauth_state');
    if (!expected || ctx.query.state !== expected || !ctx.query.code) return ctx.send(400, views.errorPage(400, 'No pudimos validar el inicio de sesión. Intenta de nuevo.'));
    try {
      const profile = await googleAuth.exchange(ctx.query.code);
      const organizer = upsertOrganizer(store, profile);
      signIn(ctx, organizer);
      log.info('auth.google.ok', { organizerId: organizer.id });
      ctx.redirect('/dashboard');
    } catch (err) {
      log.error('auth.google.error', { error: err?.message });
      ctx.send(502, views.errorPage(502, 'Google no respondió bien. Intenta de nuevo.'));
    }
  });
  if (authDev) {
    router.get('/auth/dev', (ctx) => ctx.send(200, views.devLoginPage({})));
    router.post('/auth/dev', (ctx) => {
      const email = String(ctx.body.email || '').trim().toLowerCase();
      const name = String(ctx.body.name || '').trim();
      if (!email || !name) return ctx.send(400, views.devLoginPage({ err: 'Escribe nombre y correo.' }));
      const organizer = upsertOrganizer(store, { sub: `dev:${email}`, email, name });
      signIn(ctx, organizer);
      ctx.redirect('/dashboard');
    });
  }
  router.post('/auth/logout', (ctx) => { ctx.clearCookie(SESSION_COOKIE); ctx.redirect('/'); });

  // ----- organizer -----
  router.get('/dashboard', (ctx) => {
    const organizer = requireOrganizer(ctx); if (!organizer) return;
    const colectas = service.listForOrganizer(organizer);
    const summaries = new Map(colectas.map((c) => [c.id, service.summary(c.id)]));
    ctx.send(200, views.dashboardPage({ organizer, colectas, summaries, authDev }));
  });
  router.get('/colectas/new', (ctx) => {
    const organizer = requireOrganizer(ctx); if (!organizer) return;
    ctx.send(200, views.newColectaPage({ organizer, authDev }));
  });
  router.post('/colectas', async (ctx) => {
    const organizer = requireOrganizer(ctx); if (!organizer) return;
    try {
      const colecta = await service.create(organizer, {
        ...parseConfigForm(ctx.body), organizerName: ctx.body.organizerName, organizerPhone: ctx.body.organizerPhone, clabe: ctx.body.clabe,
      });
      ctx.redirect(`/colectas/${colecta.id}?msg=creada`);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      ctx.send(400, views.newColectaPage({ organizer, err: err.message, values: ctx.body, authDev }));
    }
  });
  router.get('/colectas/:id', (ctx) => {
    const organizer = requireOrganizer(ctx); if (!organizer) return;
    const colecta = ownedColecta(ctx, organizer);
    const msgs = { creada: '¡Colecta creada! Comparte el link para que la gente se sume.', confirmada: 'Montos congelados y cobros enviados.', ok: 'Listo.' };
    renderOrganizer(ctx, organizer, colecta, { msg: msgs[ctx.query.msg] });
  });
  router.get('/colectas/:id/edit', (ctx) => {
    const organizer = requireOrganizer(ctx); if (!organizer) return;
    ctx.send(200, views.editColectaPage({ organizer, colecta: ownedColecta(ctx, organizer), authDev }));
  });
  router.post('/colectas/:id/edit', (ctx) => {
    const organizer = requireOrganizer(ctx); if (!organizer) return;
    const colecta = ownedColecta(ctx, organizer);
    try {
      service.updateConfig(colecta, organizer, parseConfigForm(ctx.body, { partial: true }));
      ctx.redirect(`/colectas/${colecta.id}?msg=ok`);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      ctx.send(400, views.editColectaPage({ organizer, colecta, err: err.message, authDev }));
    }
  });
  const organizerAction = (fn) => async (ctx) => {
    const organizer = requireOrganizer(ctx); if (!organizer) return;
    const colecta = ownedColecta(ctx, organizer);
    try {
      const msg = await fn(ctx, organizer, colecta);
      ctx.redirect(`/colectas/${colecta.id}${msg ? `?msg=${msg}` : ''}`);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      renderOrganizer(ctx, organizer, service.byId(colecta.id), { err: err.message });
    }
  };
  router.post('/colectas/:id/proposals', organizerAction((ctx, o, c) => { service.propose(c, `o:${o.id}`, ctx.body.title); return 'ok'; }));
  router.post('/colectas/:id/vote', organizerAction((ctx, o, c) => { service.vote(c, `o:${o.id}`, ctx.body.proposalId); return 'ok'; }));
  router.post('/colectas/:id/close-voting', organizerAction(async (ctx, o, c) => { await service.closeVoting(c, o, { proposalId: ctx.body.proposalId || null, ownPick: ctx.body.ownPick || null }); return 'ok'; }));
  router.post('/colectas/:id/confirm', organizerAction(async (ctx, o, c) => {
    await service.confirm(c, o, { acceptBelowGoal: ctx.body.acceptBelowGoal === '1' });
    return 'confirmada';
  }));
  router.post('/colectas/:id/outcome', organizerAction(async (ctx, o, c) => {
    const { action } = ctx.body;
    if (action === 'cancel') await service.cancel(c, o);
    else if (action === 'change_gift') await service.changeGift(c, o, { giftIdea: ctx.body.giftIdea, deadline: parseConfigForm({ deadline: ctx.body.deadline }, { partial: true }).deadline });
    else if (action === 'lower_goal') {
      const goalCents = parsePesos(ctx.body.goal);
      if (goalCents === null) throw new DomainError('Escribe la nueva meta en pesos.');
      const deadline = ctx.body.deadline ? parseConfigForm({ deadline: ctx.body.deadline }, { partial: true }).deadline : null;
      await service.lowerGoal(c, o, { goalCents, deadline });
    } else throw new DomainError('Acción desconocida.');
    return 'ok';
  }));

  // ----- participants (no login) -----
  const publicColecta = (ctx) => {
    const c = service.byCode(ctx.params.code);
    if (!c) throw new DomainError('Ese link no existe o ya no está activo.', 404);
    return c;
  };
  router.get('/c/:code', (ctx) => {
    const colecta = publicColecta(ctx);
    const participant = currentParticipant(ctx, colecta);
    if (participant) return renderParticipant(ctx, colecta, participant, { msg: ctx.query.msg === 'joined' ? '¡Ya estás dentro! Te avisamos por WhatsApp cómo va.' : undefined });
    ctx.send(200, views.joinPage({ colecta, summary: service.summary(colecta.id) }));
  });
  router.post('/c/:code/join', async (ctx) => {
    const colecta = publicColecta(ctx);
    const b = ctx.body;
    try {
      const input = { name: b.name, phone: b.phone, mode: b.mode };
      if (b.mode === 'fixed') {
        input.fixedCents = parsePesos(b.fixed);
        if (input.fixedCents === null) throw new DomainError('Escribe el monto fijo en pesos.');
      }
      if (b.mode === 'majority_cap') {
        input.capCents = parsePesos(b.cap);
        if (input.capCents === null) throw new DomainError('Escribe tu máximo en pesos.');
      }
      const participant = await service.join(colecta, input);
      rememberParticipant(ctx, colecta, participant);
      ctx.redirect(`/c/${colecta.code}?msg=joined`);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      ctx.send(400, views.joinPage({ colecta, summary: service.summary(colecta.id), err: err.message, values: b }));
    }
  });
  const participantAction = (fn) => (ctx) => {
    const colecta = publicColecta(ctx);
    const participant = currentParticipant(ctx, colecta);
    if (!participant) return ctx.redirect(`/c/${colecta.code}`);
    try {
      fn(ctx, participant, colecta);
      ctx.redirect(`/c/${colecta.code}`);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      renderParticipant(ctx, colecta, participant, { err: err.message });
    }
  };
  router.post('/c/:code/proposals', participantAction((ctx, p, c) => service.propose(c, `p:${p.id}`, ctx.body.title)));
  router.post('/c/:code/vote', participantAction((ctx, p, c) => service.vote(c, `p:${p.id}`, ctx.body.proposalId)));

  // ----- landing contact form -----
  // JSON for the landing's fetch (Accept: application/json), redirect back to the landing for
  // plain form posts. Logs carry only the outcome, never the name, email or message.
  router.post('/contact', async (ctx) => {
    const origin = String(ctx.req.headers.origin || '').replace(/\/+$/, '');
    const allowed = [...config.contact.allowedOrigins, config.baseUrl];
    const cors = origin && allowed.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : { vary: 'Origin' };
    const wantsJson = String(ctx.req.headers.accept || '').includes('application/json');
    const reply = (status, ok, error) => {
      if (wantsJson) {
        ctx.res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors });
        return ctx.res.end(JSON.stringify(ok ? { ok: true } : { ok: false, error }));
      }
      return ctx.redirect(`${config.contact.landingUrl}/?contacto=${ok ? 'enviado' : 'error'}#contacto`);
    };
    if (origin && !allowed.includes(origin)) { log.warn('contact.rejected', { reason: 'origin' }); return reply(403, false, 'No pudimos enviar tu mensaje.'); }
    if (!config.contact.to || !mailer) { log.warn('contact.rejected', { reason: 'disabled' }); return reply(503, false, 'El formulario no está disponible por ahora. Intenta más tarde.'); }
    // Honeypot: people never see the "website" field; bots fill it. Pretend it worked.
    if (String(ctx.body.website || '').trim()) { log.info('contact.rejected', { reason: 'honeypot' }); return reply(200, true); }
    const checked = validateContact(ctx.body);
    if (!checked.ok) { log.info('contact.rejected', { reason: 'invalid' }); return reply(400, false, checked.error); }
    if (!contactLimiter.allow(clientIp(ctx.req))) { log.warn('contact.rejected', { reason: 'rate_limit' }); return reply(429, false, 'Recibimos varios mensajes seguidos. Intenta de nuevo en unos minutos.'); }
    try {
      const { messageId } = await mailer.send(buildContactEmail(checked.value, config.contact));
      log.info('contact.sent', { messageId });
      return reply(200, true);
    } catch (err) {
      log.error('contact.error', { status: err?.status, code: err?.code || err?.name });
      return reply(502, false, 'No pudimos enviar tu mensaje. Intenta de nuevo en un rato.');
    }
  });

  // ----- webhooks -----
  router.post('/webhooks/arturito', async (ctx) => {
    if (!bearerOk(ctx.req.headers.authorization, config.arturito.webhookToken)) {
      log.warn('webhook.arturito.unauthorized', {});
      return ctx.json(401, { error: 'unauthorized' });
    }
    const events = Array.isArray(ctx.body) ? ctx.body : Array.isArray(ctx.body.events) ? ctx.body.events : [ctx.body];
    let replies = 0;
    for (const event of events) {
      const reply = await inbound.handle(event);
      if (reply) { queue.enqueue({ chatId: event.chatId, text: reply }); replies += 1; }
    }
    ctx.json(200, { ok: true, handled: events.length, replies });
  });
  // Standard Webhooks: verified over the raw body, deduplicated on webhook-id. Unknown ids
  // and replays answer 200 so Pey does not retry them.
  router.post('/webhooks/pey', async (ctx) => {
    let event;
    try {
      event = pey.parseWebhook({ headers: ctx.req.headers, rawBody: ctx.rawBody });
    } catch (err) {
      if (err instanceof PeyWebhookError) { log.warn('webhook.pey.rejected', { reason: err.message }); return ctx.json(401, { error: 'unauthorized' }); }
      throw err;
    }
    const result = await service.handlePeyEvent(event);
    log.info('webhook.pey', { webhookId: event.id, event: event.event, transactionId: event.transactionId, bankAccountId: event.bankAccountId, ...result });
    ctx.json(200, { ok: true, ...result });
  });

  const server = createServer(router, {
    secure: config.cookieSecure,
    onError: (ctx, err) => {
      if (err instanceof DomainError) return ctx.send(err.status, views.errorPage(err.status, err.message));
      log.error('http.error', { path: ctx.url.pathname, error: err?.message });
      ctx.send(500, views.errorPage(500, 'Algo salió mal. Intenta de nuevo.'));
    },
  });
  return { server, router };
}
