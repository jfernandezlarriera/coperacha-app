// Outbound email for the landing contact form. SesMailer calls the Amazon SES v2 API
// (SendEmail) signed with SigV4, reusing the S3 client's signer and credential provider so
// the app keeps zero npm dependencies. MockMailer records messages for tests and local runs.
// Nothing here logs addresses, names or message text.
import crypto from 'node:crypto';
import { signV4, createCredentialProvider } from '../db/s3-objects.js';

export class MailerError extends Error {
  constructor(status, code) {
    super(`SES SendEmail failed: ${status} ${code}`);
    this.name = 'MailerError';
    this.status = status;
    this.code = code;
  }
}

// message: { from, to, replyTo, subject, text }. Resolves to { messageId }.
export class SesMailer {
  constructor({ region = 'us-east-2', credentials = createCredentialProvider(), fetchImpl = fetch, clock = () => new Date(), timeoutMs = 10_000 } = {}) {
    this.region = region;
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.timeoutMs = timeoutMs;
  }

  async send({ from, to, replyTo, subject, text }) {
    const host = `email.${this.region}.amazonaws.com`;
    const path = '/v2/email/outbound-emails';
    const body = JSON.stringify({
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      ReplyToAddresses: replyTo ? [replyTo] : [],
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Text: { Data: text, Charset: 'UTF-8' } },
        },
      },
    });
    const headers = signV4({
      method: 'POST', host, path, headers: { 'content-type': 'application/json' },
      payloadHash: crypto.createHash('sha256').update(body).digest('hex'),
      credentials: await this.credentials(), region: this.region, service: 'ses', now: this.clock(),
    });
    delete headers.host;
    const res = await this.fetchImpl(`https://${host}${path}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    const data = await res.json().catch(() => ({}));
    // Only the HTTP status and the error type leave this function: SES error messages can
    // contain email addresses.
    if (!res.ok) throw new MailerError(res.status, res.headers.get('x-amzn-errortype')?.split(':')[0] || data.__type || 'Unknown');
    return { messageId: data.MessageId || '' };
  }
}

export class MockMailer {
  constructor() {
    this.sent = [];
    this.failNext = false;
  }

  async send(message) {
    if (this.failNext) { this.failNext = false; throw new MailerError(500, 'MockFailure'); }
    this.sent.push(message);
    return { messageId: `mock-${this.sent.length}` };
  }
}
