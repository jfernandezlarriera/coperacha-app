import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { buildConfig } from '../src/config.js';
import { buildSystem } from '../src/server.js';
import { Store } from '../src/db/store.js';
import { MockArturitoClient } from '../src/integrations/arturito.js';
import { MockPeyClient } from '../src/integrations/pey.js';
import { MockMailer, SesMailer, MailerError } from '../src/integrations/mailer.js';
import { validateContact, RateLimiter, buildContactEmail, LIMITS } from '../src/web/contact.js';

const config = buildConfig({
  SESSION_SECRET: 'test-secret-test-secret', AUTH_DEV_LOGIN: 'true', APP_BASE_URL: 'https://app.coperacha.app',
  DATABASE_PATH: ':memory:', CONTACT_TO: 'owner@example.com',
});
const mailer = new MockMailer();
const contactLimiter = new RateLimiter({ max: 100 });
const sys = buildSystem(config, { store: new Store(':memory:'), arturito: new MockArturitoClient(), pey: new MockPeyClient(), mailer, contactLimiter });
const base = await new Promise((resolve) => sys.server.listen(0, () => resolve(`http://127.0.0.1:${sys.server.address().port}`)));
after(() => { sys.queue.stop(); sys.server.close(); });

const post = (form, headers = {}) => fetch(`${base}/contact`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(form).toString(),
});
const good = { name: 'Lupita Pérez', email: 'Lupita@Example.com', message: 'Hola, ¿cómo funciona para una oficina?' };
const json = { accept: 'application/json', origin: 'https://coperacha.app' };

test('validateContact trims, normalizes and enforces limits', () => {
  const ok = validateContact({ name: '  Ana\r\nBcc: x@y.com ', email: ' ANA@EXAMPLE.COM ', message: ' hola ' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.name, 'Ana Bcc: x@y.com');
  assert.equal(ok.value.email, 'ana@example.com');
  assert.equal(ok.value.message, 'hola');
  assert.equal(validateContact({ email: 'a@b.co', message: 'hola' }).ok, false);
  assert.equal(validateContact({ name: 'A', email: 'not-an-email', message: 'hola' }).ok, false);
  assert.equal(validateContact({ name: 'A', email: 'a@b.co', message: '' }).ok, false);
  assert.equal(validateContact({ name: 'x'.repeat(LIMITS.name + 1), email: 'a@b.co', message: 'hola' }).ok, false);
  assert.equal(validateContact({ name: 'A', email: 'a@b.co', message: 'x'.repeat(LIMITS.message + 1) }).ok, false);
});

test('RateLimiter allows max hits per window and has a daily cap', () => {
  let now = 0;
  const rl = new RateLimiter({ max: 2, windowMs: 1000, dailyMax: 3, clock: () => now });
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), false);
  assert.equal(rl.allow('b'), true);
  now = 2000;
  assert.equal(rl.allow('a'), false, 'daily cap reached');
});

test('buildContactEmail sets reply-to to the visitor', () => {
  const m = buildContactEmail({ name: 'Ana', email: 'ana@example.com', message: 'hola' }, { to: 'o@example.com', from: 'Coperacha <hola@coperacha.app>' });
  assert.equal(m.replyTo, 'ana@example.com');
  assert.equal(m.to, 'o@example.com');
  assert.match(m.subject, /Contacto desde coperacha\.app: Ana/);
  assert.match(m.text, /hola/);
});

test('POST /contact from the landing sends one email and answers JSON with CORS', async () => {
  const before = mailer.sent.length;
  const res = await post(good, json);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://coperacha.app');
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(mailer.sent.length, before + 1);
  const m = mailer.sent.at(-1);
  assert.equal(m.to, 'owner@example.com');
  assert.equal(m.replyTo, 'lupita@example.com');
  assert.equal(m.from, 'Coperacha <hola@coperacha.app>');
});

test('POST /contact without JavaScript redirects back to the landing', async () => {
  let res = await post(good);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://coperacha.app/?contacto=enviado#contacto');
  res = await post({ ...good, email: 'nope' });
  assert.equal(res.headers.get('location'), 'https://coperacha.app/?contacto=error#contacto');
});

test('POST /contact rejects bad input, unknown origins and honeypot hits without sending', async () => {
  const before = mailer.sent.length;
  let res = await post({ ...good, message: '' }, json);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Escribe tu mensaje.');
  res = await post(good, { ...json, origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  res = await post({ ...good, website: 'http://spam.example' }, json);
  assert.equal(res.status, 200);
  assert.equal(mailer.sent.length, before);
});

test('POST /contact reports mailer failures', async () => {
  mailer.failNext = true;
  const res = await post(good, json);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).ok, false);
});

test('POST /contact is rate limited per IP', async () => {
  const cfg = buildConfig({ SESSION_SECRET: 'test-secret-test-secret', AUTH_DEV_LOGIN: 'true', DATABASE_PATH: ':memory:', CONTACT_TO: 'owner@example.com' });
  const m = new MockMailer();
  const s = buildSystem(cfg, { store: new Store(':memory:'), arturito: new MockArturitoClient(), pey: new MockPeyClient(), mailer: m, contactLimiter: new RateLimiter({ max: 1 }) });
  const url = await new Promise((resolve) => s.server.listen(0, () => resolve(`http://127.0.0.1:${s.server.address().port}/contact`)));
  try {
    const send = () => fetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.9' }, body: new URLSearchParams(good).toString() });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 429);
    assert.equal(m.sent.length, 1);
  } finally { s.queue.stop(); s.server.close(); }
});

test('POST /contact answers 503 when CONTACT_TO is not set', async () => {
  const cfg = buildConfig({ SESSION_SECRET: 'test-secret-test-secret', AUTH_DEV_LOGIN: 'true', DATABASE_PATH: ':memory:' });
  const s = buildSystem(cfg, { store: new Store(':memory:'), arturito: new MockArturitoClient(), pey: new MockPeyClient() });
  const url = await new Promise((resolve) => s.server.listen(0, () => resolve(`http://127.0.0.1:${s.server.address().port}/contact`)));
  try {
    const res = await fetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(good).toString() });
    assert.equal(res.status, 503);
  } finally { s.queue.stop(); s.server.close(); }
});

test('SesMailer signs a SES v2 SendEmail request and hides error details', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return new Response(JSON.stringify({ MessageId: 'abc' }), { status: 200 });
    return new Response(JSON.stringify({ message: 'Email address is not verified: owner@example.com' }), { status: 400, headers: { 'x-amzn-errortype': 'MessageRejected:http://internal.amazon.com/' } });
  };
  const ses = new SesMailer({ region: 'us-east-2', fetchImpl, credentials: async () => ({ accessKeyId: 'AKIDTEST', secretAccessKey: 'secret', sessionToken: 'tok' }), clock: () => new Date('2026-11-16T12:00:00Z') });
  const msg = { from: 'Coperacha <hola@coperacha.app>', to: 'o@example.com', replyTo: 'a@example.com', subject: 'Hola', text: 'Cuerpo' };
  assert.deepEqual(await ses.send(msg), { messageId: 'abc' });
  assert.equal(calls[0].url, 'https://email.us-east-2.amazonaws.com/v2/email/outbound-emails');
  assert.match(calls[0].init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/20261116\/us-east-2\/ses\/aws4_request/);
  assert.equal(calls[0].init.headers['x-amz-security-token'], 'tok');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.Destination.ToAddresses, ['o@example.com']);
  assert.deepEqual(body.ReplyToAddresses, ['a@example.com']);
  await assert.rejects(ses.send(msg), (err) => err instanceof MailerError && err.code === 'MessageRejected' && !/example\.com/.test(err.message));
});
