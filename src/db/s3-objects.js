// Minimal S3 client for one object (GET and PUT), signed with SigV4 using node:crypto and
// fetch, so the app keeps zero npm dependencies. Credentials come from the environment
// (AWS_ACCESS_KEY_ID...) or from the container credentials endpoint (App Runner instance
// role). Nothing here logs credentials or object contents.
import crypto from 'node:crypto';
import fs from 'node:fs';

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// S3 wants each path segment URI-encoded exactly once.
export function encodeKeyPath(key) {
  return '/' + String(key).split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

// Returns the headers to send (the given ones plus host, x-amz-date, x-amz-content-sha256,
// the session token if any, and authorization).
export function signV4({ method, host, path, headers = {}, payloadHash, credentials, region, service = 's3', now = new Date() }) {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const all = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (credentials.sessionToken) all['x-amz-security-token'] = credentials.sessionToken;
  const canonical = Object.entries(all)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = canonical.map(([k]) => k).join(';');
  const canonicalRequest = [
    method, path, '', canonical.map(([k, v]) => `${k}:${v}\n`).join(''), signedHeaders, payloadHash,
  ].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  let key = hmac(`AWS4${credentials.secretAccessKey}`, date);
  for (const part of [region, service, 'aws4_request']) key = hmac(key, part);
  const signature = hmac(key, stringToSign).toString('hex');
  return {
    ...Object.fromEntries(canonical),
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// Resolves credentials like the AWS SDK does for our two cases: static environment keys, or
// the container endpoint that App Runner / ECS expose for the instance role. Temporary
// credentials are cached and refreshed five minutes before they expire.
export function createCredentialProvider({ env = process.env, fetchImpl = fetch, clock = () => Date.now() } = {}) {
  let cached = null;
  return async function credentials() {
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || '' };
    }
    if (cached && cached.expiresAt - clock() > 5 * 60_000) return cached;
    const url = env.AWS_CONTAINER_CREDENTIALS_FULL_URI
      || (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ? `http://169.254.170.2${env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}` : '');
    if (!url) throw new Error('No AWS credentials: set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or run with a container role');
    const headers = {};
    const token = env.AWS_CONTAINER_AUTHORIZATION_TOKEN
      || (env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE ? fs.readFileSync(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE, 'utf8').trim() : '');
    if (token) headers.authorization = token;
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Container credentials endpoint answered ${res.status}`);
    const body = await res.json();
    cached = {
      accessKeyId: body.AccessKeyId,
      secretAccessKey: body.SecretAccessKey,
      sessionToken: body.Token || '',
      expiresAt: body.Expiration ? Date.parse(body.Expiration) : clock() + 15 * 60_000,
    };
    return cached;
  };
}

export class S3Error extends Error {
  constructor(operation, status, code) {
    super(`S3 ${operation} failed: ${status} ${code}`);
    this.name = 'S3Error';
    this.status = status;
    this.code = code;
  }
}

// { get(): Promise<string|null>, put(body: string): Promise<void> } for one bucket/key.
export function createS3Objects({ bucket, key, region = 'us-east-2', credentials = createCredentialProvider(), fetchImpl = fetch, clock = () => new Date(), timeoutMs = 15_000 }) {
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const path = encodeKeyPath(key);

  async function request(method, body, extraHeaders = {}) {
    const headers = signV4({
      method, host, path, headers: extraHeaders, payloadHash: sha256Hex(body ?? ''),
      credentials: await credentials(), region, now: clock(),
    });
    delete headers.host; // fetch sets it from the URL
    const res = await fetchImpl(`https://${host}${path}`, { method, headers, body: body ?? undefined, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] || 'Unknown';
    throw new S3Error(method, res.status, code);
  }

  return {
    // null only when the object does not exist. Needs s3:ListBucket on the bucket: without
    // it S3 answers 403 for a missing key and boot fails instead of starting empty.
    async get() {
      try {
        return await (await request('GET')).text();
      } catch (err) {
        if (err instanceof S3Error && err.status === 404 && err.code === 'NoSuchKey') return null;
        throw err;
      }
    },
    async put(body) {
      await request('PUT', body, { 'content-type': 'application/json' });
    },
  };
}
