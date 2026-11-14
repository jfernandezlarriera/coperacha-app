import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutboundQueue } from '../src/integrations/outbound-queue.js';
import { MockArturitoClient, HttpArturitoClient, registryUrl } from '../src/integrations/arturito.js';
import { buildConfig } from '../src/config.js';
import { MockPeyClient, PeyWebhookError } from '../src/integrations/pey.js';
import { InboundHandler, parseCommand } from '../src/whatsapp/inbound.js';
import { makeSystem, makeColecta, join } from './helpers.js';

function fakeClock(start = 0) {
  let now = start;
  const timers = [];
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > target) break;
        now = next.at;
        timers.shift();
        next.fn();
        await new Promise((r) => setImmediate(r));
      }
      now = target;
    },
  };
}

test('outbound queue never sends more than 6 messages per minute', async () => {
  const client = new MockArturitoClient();
  const clock = fakeClock();
  const q = new OutboundQueue({ client, limitPerMinute: 6, clock });
  for (let i = 0; i < 15; i++) q.enqueue({ chatId: `${i}@s.whatsapp.net`, text: `m${i}` });
  await q.settle();
  assert.equal(client.sends.length, 6);
  assert.equal(q.size, 9);
  await clock.advance(30_000);
  assert.equal(client.sends.length, 6, 'nothing extra inside the window');
  await clock.advance(30_001);
  assert.equal(client.sends.length, 12);
  await clock.advance(60_001);
  assert.equal(client.sends.length, 15);
  assert.equal(client.sends[14].text, 'm14', 'FIFO order');
});

test('outbound queue retries on 503 and drops on 403', async () => {
  const client = new MockArturitoClient();
  const clock = fakeClock();
  const q = new OutboundQueue({ client, limitPerMinute: 6, retryDelayMs: 5_000, clock });
  client.respondWith(503);
  client.respondWith(403);
  q.enqueue({ chatId: 'a@s.whatsapp.net', text: 'retry me' });
  q.enqueue({ chatId: 'b@s.whatsapp.net', text: 'forbidden' });
  await q.settle();
  assert.equal(client.sends.length, 2);
  assert.equal(q.dropped.length, 1);
  assert.equal(q.size, 1, '503 message is back in the queue');
  await clock.advance(5_001);
  assert.equal(client.sends.length, 3);
  assert.equal(client.sends[2].text, 'retry me');
  assert.equal(q.sent.length, 1);
});

test('pey mock: webhook needs a valid signature or bearer and normalizes status', async () => {
  const pey = new MockPeyClient({ webhookSecret: 's3cret' });
  const created = await pey.createCharge({ reference: 'CP-1', amountCents: 1000, beneficiaryClabe: '0' });
  const req = pey.webhookRequest(created.chargeId, 'PAID', 'CP-1');
  assert.deepEqual(pey.parseWebhook(req), { chargeId: created.chargeId, status: 'paid', reference: 'CP-1' });
  assert.throws(() => pey.parseWebhook({ headers: { 'x-pey-signature': 'bad' }, rawBody: req.rawBody }), PeyWebhookError);
  assert.throws(() => pey.parseWebhook({ headers: {}, rawBody: req.rawBody }), PeyWebhookError);
  const bearer = pey.parseWebhook({ headers: { authorization: 'Bearer s3cret' }, rawBody: JSON.stringify({ id: 'x', status: 'failed' }) });
  assert.equal(bearer.status, 'failed');
  assert.throws(() => pey.parseWebhook({ headers: { authorization: 'Bearer s3cret' }, rawBody: 'nope' }), /json/);
});

test('inbound commands parse with and without accents', () => {
  assert.deepEqual(parseCommand('¿Cuánto falta?'), { cmd: 'remaining' });
  assert.deepEqual(parseCommand('MI MONTO'), { cmd: 'my_amount' });
  assert.deepEqual(parseCommand('Proponer: bocina bluetooth'), { cmd: 'propose', title: 'bocina bluetooth' });
  assert.deepEqual(parseCommand('votar 2'), { cmd: 'vote', index: 2 });
  assert.deepEqual(parseCommand('votar'), { cmd: 'proposals' });
  assert.deepEqual(parseCommand('hola'), { cmd: 'menu' });
  assert.deepEqual(parseCommand('xyz'), { cmd: 'unknown' });
});

test('inbound handler serves joined numbers, ignores unknown chats and never leaks amounts', async () => {
  const sys = makeSystem();
  const c = await makeColecta(sys, { goalCents: 50000 });
  const a = await join(sys, c, { name: 'Ana', phone: '5511112222', mode: 'fixed', fixedCents: 20000 });
  await join(sys, c, { name: 'Beto', phone: '5533334444', mode: 'majority_cap', capCents: 5000 });
  const h = new InboundHandler({ service: sys.service });
  const chat = '525511112222@s.whatsapp.net';
  assert.equal(await h.handle({ chatId: '529999999999@s.whatsapp.net', type: 'text', messageId: 'm0', text: 'hola' }), null);
  assert.equal(await h.handle({ chatId: chat, type: 'image', messageId: 'm1' }), null);
  assert.match(await h.handle({ chatId: chat, type: 'text', messageId: 'm2', text: 'menu' }), /proponer/);
  const remaining = await h.handle({ chatId: chat, type: 'text', messageId: 'm3', text: 'cuanto falta' });
  assert.match(remaining, /\$250\.00 de \$500\.00/);
  assert.doesNotMatch(remaining, /Beto|\$50\.00/);
  assert.match(await h.handle({ chatId: chat, type: 'text', messageId: 'm4', text: 'mi monto' }), /\$200\.00/);
  assert.match(await h.handle({ chatId: chat, type: 'text', messageId: 'm5', text: 'proponer Bocina' }), /Bocina/);
  assert.match(await h.handle({ chatId: chat, type: 'text', messageId: 'm6', text: 'votar' }), /1\. Bocina/);
  assert.match(await h.handle({ chatId: chat, type: 'text', messageId: 'm7', text: 'votar 1' }), /quedó en "Bocina"/);
  assert.equal(sys.service.votingBoard(c.id).votes[0].voter, `p:${a.id}`);
  assert.match(await h.handle({ chatId: chat, type: 'text', messageId: 'm8', text: 'votar 9' }), /Opciones/);
  assert.match(await h.handle({ chatId: '525511112222@lid', type: 'text', messageId: 'm9', text: 'menu' }) ?? '', /^$/ , '@lid without mapping is a no-op');
});

// Fake fetch: records every call and answers with the given status. No network.
function fakeFetch(status = 200) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    if (status instanceof Error) throw status;
    return { status };
  };
  return { calls, impl };
}

test('arturito register/unregister: POST/DELETE <send url>/registry with only {chatId} and the bot key', async () => {
  const f = fakeFetch(200);
  const client = new HttpArturitoClient({ sendUrl: 'https://arturito.test/api/send/', sendKey: 'bot-key', fetchImpl: f.impl });
  const res = await client.register({ phone: '525512345678', role: 'participant', colectaId: 'c1' });
  assert.equal(res.status, 200);
  assert.deepEqual(f.calls.map((c) => c.body), [
    { chatId: '5215512345678@s.whatsapp.net' },
    { chatId: '525512345678@s.whatsapp.net' },
  ], '521 JID first (what inbound events carry), then the 52 form used for outbound sends');
  for (const call of f.calls) {
    assert.equal(call.url, 'https://arturito.test/api/send/registry');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, 'Bearer bot-key');
  }

  await client.unregister({ phone: '5215512345678', role: 'participant', colectaId: 'c1' });
  assert.deepEqual(f.calls.slice(2).map((c) => [c.method, c.url, c.body]), [
    ['DELETE', 'https://arturito.test/api/send/registry', { chatId: '5215512345678@s.whatsapp.net' }],
    ['DELETE', 'https://arturito.test/api/send/registry', { chatId: '525512345678@s.whatsapp.net' }],
  ]);

  assert.equal(registryUrl('https://arturito.test/api/send'), 'https://arturito.test/api/send/registry');
  assert.equal(registryUrl('https://arturito.test/api/send///'), 'https://arturito.test/api/send/registry');

  await client.register({ phone: '14155550123', role: 'participant', colectaId: 'c1' });
  assert.deepEqual(f.calls.slice(4).map((c) => c.body), [{ chatId: '14155550123@s.whatsapp.net' }], 'non-Mexican numbers register one chatId');
});

test('arturito register is skipped without send URL or key, and never throws on network errors', async () => {
  const f = fakeFetch(200);
  const noUrl = new HttpArturitoClient({ sendUrl: '', sendKey: 'bot-key', fetchImpl: f.impl });
  const noKey = new HttpArturitoClient({ sendUrl: 'https://arturito.test/api/send', sendKey: '', fetchImpl: f.impl });
  for (const client of [noUrl, noKey]) {
    assert.deepEqual(await client.register({ phone: '525512345678', role: 'organizer', colectaId: 'c1' }), { status: 0, skipped: true });
    assert.deepEqual(await client.unregister({ phone: '525512345678', role: 'organizer', colectaId: 'c1' }), { status: 0, skipped: true });
  }
  assert.equal(f.calls.length, 0);

  const down = fakeFetch(new Error('ECONNREFUSED'));
  const client = new HttpArturitoClient({ sendUrl: 'https://arturito.test/api/send', sendKey: 'bot-key', fetchImpl: down.impl });
  const res = await client.register({ phone: '525512345678', role: 'organizer', colectaId: 'c1' });
  assert.equal(res.error, true);
  assert.equal(down.calls.length, 2, 'both chatIds are attempted');

  const cfg = buildConfig({ ARTURITO_SEND_URL: 'https://arturito.test/api/send', ARTURITO_SEND_KEY: 'k' });
  assert.deepEqual(Object.keys(cfg.arturito).sort(), ['phone', 'sendKey', 'sendLimitPerMinute', 'sendUrl', 'webhookToken']);
});

test('inbound finds the participant from the 52 or the 521 chatId; joining registers both forms', async () => {
  const sys = makeSystem();
  const c = await makeColecta(sys, { goalCents: 50000 });
  await join(sys, c, { name: 'Ana', phone: '5511112222', mode: 'fixed', fixedCents: 20000 });
  assert.deepEqual(sys.arturito.registrations.at(-1).chatIds, ['5215511112222@s.whatsapp.net', '525511112222@s.whatsapp.net']);
  const h = new InboundHandler({ service: sys.service });
  for (const chatId of ['525511112222@s.whatsapp.net', '5215511112222@s.whatsapp.net']) {
    assert.match(await h.handle({ chatId, type: 'text', messageId: 'm', text: 'mi monto' }), /\$200\.00/);
  }
  assert.equal(await h.handle({ chatId: '5215511112223@s.whatsapp.net', type: 'text', messageId: 'm', text: 'mi monto' }), null);
  assert.equal(await h.handle({ chatId: '5215511112222@lid', type: 'text', messageId: 'm', text: 'mi monto' }), null, '@lid has no mapping');
});
