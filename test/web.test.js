import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../src/config.js';
import { buildSystem } from '../src/server.js';
import { Store } from '../src/db/store.js';
import { MockArturitoClient } from '../src/integrations/arturito.js';
import { MockPeyClient } from '../src/integrations/pey.js';
import { CLABE, fixedClock } from './helpers.js';
import { utcToZonedInput } from '../src/util/time.js';

const config = buildConfig({
  SESSION_SECRET: 'test-secret-test-secret', AUTH_DEV_LOGIN: 'true', APP_BASE_URL: 'https://coperacha.app',
  ARTURITO_PHONE: '5215500000000', ARTURITO_WEBHOOK_TOKEN: 'hook-token', PEY_WEBHOOK_SECRET: 'pey-secret', DATABASE_PATH: ':memory:',
});
const clock = fixedClock();
const arturito = new MockArturitoClient();
const pey = new MockPeyClient({ webhookSecret: 'pey-secret' });
const sys = buildSystem(config, { store: new Store(':memory:'), arturito, pey, clock });
const base = await new Promise((resolve) => sys.server.listen(0, () => resolve(`http://127.0.0.1:${sys.server.address().port}`)));
after(() => sys.server.close());

// Minimal cookie-jar client (one jar per persona).
function client() {
  const jar = {};
  return async (path, { method = 'GET', form, json, headers = {} } = {}) => {
    const h = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...headers };
    let body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json !== undefined) { h['content-type'] = 'application/json'; body = typeof json === 'string' ? json : JSON.stringify(json); }
    const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair, ...attrs] = c.split(';');
      const [k, v] = pair.split('=');
      if (attrs.some((a) => a.trim() === 'Max-Age=0')) delete jar[k]; else jar[k] = v;
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };
}

const deadlineInput = utcToZonedInput(new Date(clock().getTime() + 5 * 864e5));

test('full walkthrough over HTTP: sign in, create, join, vote, confirm, see contributors', async () => {
  const org = client();
  let r = await org('/dashboard');
  assert.equal(r.status, 303, 'dashboard requires sign-in');
  r = await org('/auth/dev', { method: 'POST', form: { name: 'Ana', email: 'ana@example.com' } });
  assert.equal(r.location, '/dashboard');
  r = await org('/colectas', { method: 'POST', form: { giftIdea: 'Bocina', goal: '600', deadline: deadlineInput, splitMode: 'free', organizerName: 'Ana', organizerPhone: '5512345678', clabe: 'bad' } });
  assert.equal(r.status, 400);
  assert.match(r.text, /CLABE/);
  r = await org('/colectas', { method: 'POST', form: { giftIdea: 'Bocina', goal: '600', deadline: deadlineInput, splitMode: 'free', organizerName: 'Ana', organizerPhone: '5512345678', clabe: CLABE } });
  assert.equal(r.status, 303);
  const colectaId = r.location.split('/')[2].split('?')[0];
  const colecta = sys.service.byId(colectaId);
  r = await org(`/colectas/${colectaId}`);
  assert.match(r.text, new RegExp(`https://coperacha.app/c/${colecta.code}`));
  assert.match(r.text, /https:\/\/wa\.me\/5215500000000\?text=/);
  assert.match(r.text, new RegExp(colecta.code));

  const other = client();
  await other('/auth/dev', { method: 'POST', form: { name: 'Bob', email: 'bob@example.com' } });
  assert.equal((await other(`/colectas/${colectaId}`)).status, 404, 'another organizer cannot see it');

  const luis = client();
  r = await luis(`/c/${colecta.code}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Sumarme/);
  r = await luis(`/c/${colecta.code}/join`, { method: 'POST', form: { name: 'Luis', phone: '5511112222', mode: 'fixed', fixed: '300' } });
  assert.equal(r.status, 303);
  r = await luis(`/c/${colecta.code}`);
  assert.match(r.text, /Hola, Luis/);
  assert.match(r.text, /\$300\.00/);
  assert.match(r.text, /se muestra solo cuando la colecta se confirma/);
  r = await luis(`/c/${colecta.code}/proposals`, { method: 'POST', form: { title: 'Bocina JBL' } });
  const proposal = sys.service.proposals(colectaId)[0];
  r = await luis(`/c/${colecta.code}/vote`, { method: 'POST', form: { proposalId: proposal.id } });
  assert.equal(r.status, 303);

  const mar = client();
  r = await mar(`/c/${colecta.code}/join`, { method: 'POST', form: { name: 'Mar', phone: '5533334444', mode: 'majority_cap', cap: '100' } });
  assert.equal(r.status, 303);
  r = await mar(`/c/${colecta.code}`);
  assert.match(r.text, /\$100\.00/, 'Mar sees her own provisional amount');
  assert.doesNotMatch(r.text, /Luis.*\$300/s, 'Mar does not see who put what');
  r = await luis(`/c/${colecta.code}`);
  assert.doesNotMatch(r.text, /\$100\.00/, 'Luis never sees Mar cap');

  r = await org(`/colectas/${colectaId}`);
  assert.match(r.text, /Luis, Mar/);
  assert.doesNotMatch(r.text, /Quién puso cuánto/);
  assert.doesNotMatch(r.text, /\$100\.00/, 'organizer does not see the private cap');
  r = await org(`/colectas/${colectaId}/confirm`, { method: 'POST' });
  assert.equal(r.status, 400, 'cannot confirm before goal');

  const sol = client();
  await sol(`/c/${colecta.code}/join`, { method: 'POST', form: { name: 'Sol', phone: '5555556666', mode: 'fixed', fixed: '300' } });
  assert.equal(sys.service.byId(colectaId).status, 'goal_reached');
  r = await org(`/colectas/${colectaId}/close-voting`, { method: 'POST', form: { proposalId: '', ownPick: '' } });
  assert.equal(sys.service.byId(colectaId).finalGift, 'Bocina JBL');
  r = await org(`/colectas/${colectaId}/confirm`, { method: 'POST' });
  assert.equal(r.location, `/colectas/${colectaId}?msg=confirmada`);
  assert.equal(pey.charges.length, 3);
  r = await org(`/colectas/${colectaId}`);
  assert.match(r.text, /Quién puso cuánto/);
  assert.match(r.text, /Mar<\/td><td>\$100\.00/);
  r = await mar(`/c/${colecta.code}`);
  assert.match(r.text, /Luis<\/td><td>\$300\.00/, 'contributors visible to participants after confirmation');

  // Pey webhook: wrong auth rejected, good signature updates the charge.
  const charge = sys.service.charges(colectaId)[0];
  r = await org('/webhooks/pey', { method: 'POST', json: { chargeId: charge.peyChargeId, status: 'paid' } });
  assert.equal(r.status, 401);
  const signed = pey.webhookRequest(charge.peyChargeId, 'paid');
  r = await org('/webhooks/pey', { method: 'POST', json: signed.rawBody, headers: signed.headers });
  assert.equal(r.status, 200);
  assert.equal(sys.service.charges(colectaId)[0].status, 'paid');

  // Notifications were queued, throttled, and sent through the mock client only.
  await sys.queue.settle();
  assert.ok(arturito.sends.length <= 6, `at most 6 sends in the first minute, got ${arturito.sends.length}`);
  assert.ok(sys.queue.size + arturito.sends.length >= 6, 'joined x3 + goal reached + gift chosen x3 + charges x3');

  r = await org('/auth/logout', { method: 'POST' });
  assert.equal((await org('/dashboard')).status, 303);
});

test('Arturito webhook requires the bearer token and routes commands', async () => {
  const c = client();
  let r = await c('/webhooks/arturito', { method: 'POST', json: { chatId: '525511112222@s.whatsapp.net', type: 'text', messageId: 'x', text: 'menu' } });
  assert.equal(r.status, 401);
  r = await c('/webhooks/arturito', { method: 'POST', json: { chatId: '525511112222@s.whatsapp.net', type: 'text', messageId: 'x', text: 'menu' }, headers: { authorization: 'Bearer wrong' } });
  assert.equal(r.status, 401);
  const before = sys.queue.size + arturito.sends.length;
  r = await c('/webhooks/arturito', { method: 'POST', json: { chatId: '525511112222@s.whatsapp.net', type: 'text', messageId: 'x', text: 'mi monto' }, headers: { authorization: 'Bearer hook-token' } });
  assert.equal(r.status, 200);
  assert.match(r.text, /"replies":1/);
  assert.equal(sys.queue.size + arturito.sends.length, before + 1);
  r = await c('/webhooks/arturito', { method: 'POST', json: { chatId: '520000000000@s.whatsapp.net', type: 'text', messageId: 'y', text: 'hola' }, headers: { authorization: 'Bearer hook-token' } });
  assert.match(r.text, /"replies":0/);
});

test('session cookies are httpOnly and signed; tampering logs you out', async () => {
  const res = await fetch(`${base}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=Zoe&email=zoe@example.com', redirect: 'manual' });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('cp_session='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const value = cookie.split(';')[0];
  const ok = await fetch(`${base}/dashboard`, { headers: { cookie: value }, redirect: 'manual' });
  assert.equal(ok.status, 200);
  const bad = await fetch(`${base}/dashboard`, { headers: { cookie: value.slice(0, -2) + 'zz' }, redirect: 'manual' });
  assert.equal(bad.status, 303);
});
