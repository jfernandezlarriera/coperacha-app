import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidClabe, makeClabe } from '../src/util/clabe.js';
import { normalizePhone, phoneFromChatId, chatIdForPhone, registryChatIds, waMeLink } from '../src/util/phone.js';
import { parsePesos, formatMXN } from '../src/util/money.js';
import { zonedToUtc, utcToZonedInput, formatZoned } from '../src/util/time.js';
import { encodeSigned, decodeSigned } from '../src/util/cookies.js';
import { Store } from '../src/db/store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('CLABE: 18 digits with a valid check digit', () => {
  const ok = makeClabe('01218000123456789');
  assert.ok(isValidClabe(ok));
  assert.ok(isValidClabe(ok.replace(/(.{4})/g, '$1 ')));
  assert.ok(!isValidClabe(ok.slice(0, 17) + ((Number(ok[17]) + 1) % 10)));
  assert.ok(!isValidClabe('12345'));
  assert.ok(!isValidClabe('0121800012345678A9'));
});

test('phones normalize to 52 + 10 digits and map to chatIds', () => {
  assert.equal(normalizePhone('55 1234 5678'), '525512345678');
  assert.equal(normalizePhone('+52 1 55 1234 5678'), '525512345678');
  assert.equal(normalizePhone('5215512345678'), '525512345678');
  assert.equal(normalizePhone('12'), null);
  assert.equal(chatIdForPhone('525512345678'), '525512345678@s.whatsapp.net');
  assert.equal(phoneFromChatId('5215512345678@s.whatsapp.net'), '525512345678');
  assert.equal(phoneFromChatId('525512345678@s.whatsapp.net'), '525512345678');
  assert.equal(phoneFromChatId('123456@lid'), null);
  assert.deepEqual(registryChatIds('525512345678'), ['5215512345678@s.whatsapp.net', '525512345678@s.whatsapp.net']);
  assert.deepEqual(registryChatIds('5215512345678'), registryChatIds('5512345678'));
  assert.deepEqual(registryChatIds('14155550123'), ['14155550123@s.whatsapp.net']);
  assert.deepEqual(registryChatIds('12'), []);
  assert.equal(waMeLink('525512345678', 'hola'), 'https://wa.me/525512345678?text=hola', 'wa.me keeps the 52 form');
});

test('money parses pesos to centavos and formats MXN', () => {
  assert.equal(parsePesos('1,500.5'), 150050);
  assert.equal(parsePesos('$300'), 30000);
  assert.equal(parsePesos('abc'), null);
  assert.equal(parsePesos('1.234'), null);
  assert.equal(formatMXN(150050), '$1,500.50');
});

test('deadlines convert between Mexico City wall time and UTC', () => {
  const utc = zonedToUtc('2026-12-01T18:00');
  assert.equal(utc.toISOString(), '2026-12-02T00:00:00.000Z');
  assert.equal(utcToZonedInput(utc), '2026-12-01T18:00');
  assert.equal(formatZoned(utc), '1 dic 2026, 18:00');
  assert.equal(zonedToUtc('garbage'), null);
});

test('signed cookies round-trip and reject tampering', () => {
  const v = encodeSigned({ a: 1 }, 'secret');
  assert.deepEqual(decodeSigned(v, 'secret'), { a: 1 });
  assert.equal(decodeSigned(v, 'other'), null);
  assert.equal(decodeSigned(v + 'x', 'secret'), null);
});

test('store persists to disk and reloads', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-')), 'db.json');
  const s1 = new Store(file);
  s1.insert('organizers', { id: 'o1', name: 'A' });
  s1.update('organizers', 'o1', { name: 'B' });
  const s2 = new Store(file);
  assert.equal(s2.get('organizers', 'o1').name, 'B');
  assert.equal(s2.data.schemaVersion, 1);
  fs.rmSync(path.dirname(file), { recursive: true });
});
