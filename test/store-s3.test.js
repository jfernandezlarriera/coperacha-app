process.env.NODE_ENV = 'test';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db/store.js';
import { S3Mirror } from '../src/db/s3-mirror.js';
import { openStore } from '../src/db/open-store.js';
import { buildConfig } from '../src/config.js';
import { signV4, encodeKeyPath, createCredentialProvider, createS3Objects } from '../src/db/s3-objects.js';

// In-memory stand-in for the bucket object. No network anywhere in this file.
function fakeObjects(initial = null) {
  const fake = {
    body: initial, puts: 0, gets: 0, failPuts: 0, failGet: null, gate: null,
    async get() {
      fake.gets += 1;
      if (fake.failGet) throw fake.failGet;
      return fake.body;
    },
    async put(body) {
      if (fake.gate) await fake.gate;
      if (fake.failPuts > 0) { fake.failPuts -= 1; throw Object.assign(new Error('down'), { name: 'S3Error', status: 503 }); }
      fake.puts += 1;
      fake.body = body;
    },
  };
  return fake;
}

const organizer = (id) => ({ id, googleSub: `g-${id}`, email: `${id}@example.com`, name: id, createdAt: '2026-11-14T12:00:00.000Z' });
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coperacha-store-')), 'db.json');

test('without a bucket the store is the plain local file', async () => {
  const file = tmpFile();
  const store = await openStore(buildConfig({ DATABASE_PATH: file }));
  assert.equal(store.remote, null);
  store.insert('organizers', organizer('a'));
  await store.flush();
  assert.equal(new Store(file).get('organizers', 'a').id, 'a');
});

test('with a bucket: loads from S3 on boot and writes back after each persist', async () => {
  const seed = new Store(':memory:');
  seed.insert('organizers', organizer('a'));
  const objects = fakeObjects(JSON.stringify(seed.data));
  const file = tmpFile();
  const config = buildConfig({ DATABASE_PATH: file, DATABASE_S3_BUCKET: 'bucket', DATABASE_S3_KEY: 'k.json' });

  const store = await openStore(config, { objects });
  assert.equal(store.get('organizers', 'a').id, 'a');
  assert.equal(objects.puts, 0, 'loading does not write');

  store.insert('organizers', organizer('b'));
  store.update('organizers', 'a', { name: 'changed' });
  await store.flush();
  const remote = JSON.parse(objects.body);
  assert.deepEqual(remote.organizers.map((o) => o.id), ['a', 'b']);
  assert.equal(remote.organizers[0].name, 'changed');

  // A new instance (fresh disk) sees the same data.
  const again = await openStore(buildConfig({ DATABASE_PATH: tmpFile(), DATABASE_S3_BUCKET: 'bucket' }), { objects });
  assert.equal(again.all('organizers').length, 2);
});

test('S3 copy wins over a stale local file; an empty bucket gets the local data', async () => {
  const file = tmpFile();
  new Store(file).insert('organizers', organizer('local'));

  const empty = fakeObjects(null);
  const first = new Store(file, { remote: new S3Mirror({ objects: empty }) });
  assert.equal(await first.loadRemote(), false);
  await first.flush();
  assert.deepEqual(JSON.parse(empty.body).organizers.map((o) => o.id), ['local']);

  const seed = new Store(':memory:');
  seed.insert('organizers', organizer('remote'));
  const second = new Store(file, { remote: new S3Mirror({ objects: fakeObjects(JSON.stringify(seed.data)) }) });
  assert.equal(await second.loadRemote(), true);
  assert.deepEqual(second.all('organizers').map((o) => o.id), ['remote']);
  assert.deepEqual(new Store(file).all('organizers').map((o) => o.id), ['remote']);
});

test('a failed download stops the boot instead of starting empty', async () => {
  const objects = fakeObjects();
  objects.failGet = Object.assign(new Error('denied'), { name: 'S3Error', status: 403 });
  const config = buildConfig({ DATABASE_PATH: ':memory:', DATABASE_S3_BUCKET: 'bucket' });
  await assert.rejects(() => openStore(config, { objects }), /denied/);
  assert.equal(objects.puts, 0);
});

test('uploads are serialized, coalesced and always end with the latest state', async () => {
  const objects = fakeObjects();
  let release;
  objects.gate = new Promise((resolve) => { release = resolve; });
  const store = new Store(':memory:', { remote: new S3Mirror({ objects }) });
  for (let i = 0; i < 20; i += 1) store.insert('organizers', organizer(`o${i}`));
  objects.gate = null;
  release();
  await store.flush();
  assert.equal(JSON.parse(objects.body).organizers.length, 20);
  assert.ok(objects.puts <= 2, `expected coalesced uploads, got ${objects.puts}`);
});

test('a failed upload is retried until it lands', async () => {
  const objects = fakeObjects();
  objects.failPuts = 2;
  const mirror = new S3Mirror({ objects, retryMs: 1, maxRetryMs: 2 });
  const store = new Store(':memory:', { remote: mirror });
  store.insert('organizers', organizer('a'));
  await store.flush();
  assert.equal(objects.puts, 1);
  assert.equal(mirror.lastError, null);
  assert.equal(JSON.parse(objects.body).organizers.length, 1);
});

// Example from the AWS docs ("Signature Calculations for the Authorization Header", GET Object).
test('signV4 matches the published AWS example signature', () => {
  const headers = signV4({
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    region: 'us-east-1', now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
    + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
    + 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.equal(encodeKeyPath('prod/my file(1).json'), '/prod/my%20file%281%29.json');
});

test('S3 object client: signed GET/PUT, missing key is null, other errors throw', async () => {
  const calls = [];
  const responses = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return responses.shift(); };
  const credentials = async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'example-secret', sessionToken: 'example-token' });
  const objects = createS3Objects({ bucket: 'b', key: 'prod/db.json', region: 'us-east-2', credentials, fetchImpl });

  responses.push(new Response('{"schemaVersion":1}', { status: 200 }));
  assert.equal(await objects.get(), '{"schemaVersion":1}');
  assert.equal(calls[0].url, 'https://b.s3.us-east-2.amazonaws.com/prod/db.json');
  assert.equal(calls[0].init.method, 'GET');
  assert.match(calls[0].init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-2\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
  assert.equal(calls[0].init.headers['x-amz-security-token'], 'example-token');

  responses.push(new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }));
  assert.equal(await objects.get(), null);

  responses.push(new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }));
  await assert.rejects(() => objects.get(), (err) => err.name === 'S3Error' && err.status === 403 && err.code === 'AccessDenied');

  responses.push(new Response('', { status: 200 }));
  await objects.put('{"a":1}');
  assert.equal(calls[3].init.method, 'PUT');
  assert.equal(calls[3].init.body, '{"a":1}');
  assert.equal(calls[3].init.headers['content-type'], 'application/json');

  responses.push(new Response('<Error><Code>SlowDown</Code></Error>', { status: 503 }));
  await assert.rejects(() => objects.put('{}'), (err) => err.status === 503 && !/example-secret/.test(err.message));
});

test('credentials: environment keys first, else the container endpoint with caching', async () => {
  const fromEnv = createCredentialProvider({ env: { AWS_ACCESS_KEY_ID: 'AKIDENV', AWS_SECRET_ACCESS_KEY: 'env-secret' }, fetchImpl: () => { throw new Error('no network'); } });
  assert.equal((await fromEnv()).accessKeyId, 'AKIDENV');

  let now = Date.parse('2026-11-14T12:00:00Z');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ AccessKeyId: `AKID${calls.length}`, SecretAccessKey: 'role-secret', Token: 'role-token', Expiration: new Date(now + 60 * 60_000).toISOString() });
  };
  const fromRole = createCredentialProvider({ env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc' }, fetchImpl, clock: () => now });
  assert.deepEqual([(await fromRole()).accessKeyId, (await fromRole()).sessionToken], ['AKID1', 'role-token']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://169.254.170.2/v2/credentials/abc');
  now += 56 * 60_000; // inside the five-minute refresh window
  assert.equal((await fromRole()).accessKeyId, 'AKID2');

  await assert.rejects(() => createCredentialProvider({ env: {} })(), /No AWS credentials/);
});
