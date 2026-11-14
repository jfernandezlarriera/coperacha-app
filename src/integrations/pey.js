// Pey (CoDi) client interface. Coperacha never holds money: each charge names the
// organizer's CLABE as beneficiary. The real sandbox shape is not in this repo, so the
// interface is deliberately small and the HTTP client encodes documented assumptions:
//
//   createCharge({reference, amountCents, concept, beneficiaryClabe, beneficiaryName, payerPhone})
//     -> {chargeId, status:'pending', paymentUrl}
//   parseWebhook({headers, rawBody}) -> {chargeId, status:'paid'|'failed'|'expired'|'pending', reference}
//     throws PeyWebhookError (401) when the signature/token does not verify.
import crypto from 'node:crypto';
import { log } from '../logger.js';

export class PeyWebhookError extends Error {
  constructor(message) {
    super(message);
    this.status = 401;
  }
}

function verifySignature(headers, rawBody, secret) {
  if (!secret) throw new PeyWebhookError('webhook secret not configured');
  const auth = headers['authorization'] || '';
  const sig = headers['x-pey-signature'] || '';
  if (sig) {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return;
    throw new PeyWebhookError('bad signature');
  }
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (bearer && bearer.length === secret.length && crypto.timingSafeEqual(Buffer.from(bearer), Buffer.from(secret))) return;
  throw new PeyWebhookError('unauthorized');
}

const STATUS_MAP = { paid: 'paid', completed: 'paid', settled: 'paid', failed: 'failed', rejected: 'failed', expired: 'expired', pending: 'pending', created: 'pending' };

function normalizeWebhookBody(rawBody) {
  let body;
  try { body = JSON.parse(rawBody); } catch { throw new PeyWebhookError('invalid json'); }
  const chargeId = body.chargeId || body.charge_id || body.id;
  const status = STATUS_MAP[String(body.status || '').toLowerCase()];
  if (!chargeId || !status) throw new PeyWebhookError('missing fields');
  return { chargeId, status, reference: body.reference || null };
}

export class HttpPeyClient {
  constructor({ apiUrl, apiKey, webhookSecret, fetchImpl = globalThis.fetch }) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.webhookSecret = webhookSecret;
    this.fetch = fetchImpl;
  }

  async createCharge(input) {
    const res = await this.fetch(`${this.apiUrl}/charges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        reference: input.reference,
        amount: input.amountCents / 100,
        currency: 'MXN',
        concept: input.concept,
        beneficiary: { clabe: input.beneficiaryClabe, name: input.beneficiaryName },
        payer: { phone: input.payerPhone },
      }),
    });
    if (!res.ok) {
      log.error('pey.charge.error', { status: res.status, reference: input.reference });
      throw new Error(`pey charge failed: ${res.status}`);
    }
    const data = await res.json();
    return { chargeId: data.id || data.chargeId, status: STATUS_MAP[String(data.status || 'pending').toLowerCase()] || 'pending', paymentUrl: data.paymentUrl || data.url || null };
  }

  parseWebhook({ headers, rawBody }) {
    verifySignature(headers, rawBody, this.webhookSecret);
    return normalizeWebhookBody(rawBody);
  }
}

// Mock for tests and local runs. Same interface; records charges and can build signed
// webhook payloads so the webhook endpoint can be exercised end to end.
export class MockPeyClient {
  constructor({ webhookSecret = 'mock-secret' } = {}) {
    this.webhookSecret = webhookSecret;
    this.charges = [];
    this.failNext = false;
  }

  async createCharge(input) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('pey mock: simulated failure');
    }
    const chargeId = `mock_${this.charges.length + 1}_${input.reference}`;
    const charge = { chargeId, status: 'pending', paymentUrl: `https://pey.example/pay/${chargeId}`, ...input };
    this.charges.push(charge);
    return { chargeId, status: 'pending', paymentUrl: charge.paymentUrl };
  }

  parseWebhook({ headers, rawBody }) {
    verifySignature(headers, rawBody, this.webhookSecret);
    return normalizeWebhookBody(rawBody);
  }

  // Builds the request a Pey webhook would send for a charge, signed with the secret.
  webhookRequest(chargeId, status, reference = null) {
    const rawBody = JSON.stringify({ chargeId, status, reference });
    const signature = crypto.createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    return { headers: { 'x-pey-signature': signature, 'content-type': 'application/json' }, rawBody };
  }
}
