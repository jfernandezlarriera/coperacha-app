// Pey (CoDi) client. Coperacha never holds money: every charge names the organizer's own
// bank account, registered with Pey through POST /bank-account. A raw CLABE is never sent
// on a charge; charges carry the `bankAccountId` Pey returned.
//
//   createBankAccount({alias, name, clabe, entity}) -> {id, codiStatus}
//   getBankAccount(id)                              -> {id, codiStatus}
//   createPushCharge({amountCents, phone, concept, expirationSeconds, numRef, bankAccountId, metadata})
//                                                   -> {transactionId, codiId}       (POST /codi/pn)
//   createQrCharge({amountCents, concept, expirationSeconds, numRef, bankAccountId, metadata})
//                                                   -> {transactionId, qrString}     (POST /codi/qr)
//   getTransaction(id)                              -> {transactionId, status: 'PENDING' | 'PAID'}
//   parseWebhook({headers, rawBody})                -> normalized event (see normalizeEvent)
//     throws PeyWebhookError (401) when the Standard Webhooks signature does not verify.
//
// Pey has no failed/expired events and no refunds: expiration is handled app-side.
import crypto from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { log } from '../logger.js';

export const PEY_API_BASE = 'https://api.pey.mx';
export const CODI_STATUSES = new Set(['PENDING', 'PROCESSING', 'ACTIVE', 'ERROR']);
export const CHARGE_EXPIRATION_SECONDS = 86400;
const MIN_EXPIRATION_SECONDS = 360;

// CLABEs Pey already authorized: they activate as soon as they are registered. Any other
// CLABE can take up to 5 business days.
export const PREAUTHORIZED_CLABES = [
  '012180015826225713',
  '012180015913466252',
  '014189606004536217',
  '012180015355682429',
  '127180016558860385',
];
export const isPreauthorizedClabe = (clabe) => PREAUTHORIZED_CLABES.includes(String(clabe || '').replace(/\D/g, ''));

export class PeyWebhookError extends Error {
  constructor(message) {
    super(message);
    this.status = 401;
  }
}

export class PeyApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Integer centavos -> MXN number built from the decimal string, so there is no float drift.
export function centsToAmount(cents) {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('amount must be a positive integer of centavos');
  return Number(`${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`);
}

// Pey wants the 10-digit Mexican number, without the 52 / 521 prefix.
export function tenDigitPhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('521')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('52')) digits = digits.slice(2);
  if (digits.length !== 10) throw new Error('phone is not a 10-digit Mexican number');
  return digits;
}

// Stable numeric reference of up to 7 digits derived from our own reference.
export function numRefFor(reference) {
  const n = crypto.createHash('sha256').update(String(reference)).digest().readUInt32BE(0) % 10_000_000;
  return n || 1;
}

function chargeBody(input) {
  if (!input.bankAccountId) throw new Error('bankAccountId is required');
  return {
    amount: centsToAmount(input.amountCents),
    concept: String(input.concept || 'Coperacha').slice(0, 40),
    expiration: Math.max(MIN_EXPIRATION_SECONDS, input.expirationSeconds || CHARGE_EXPIRATION_SECONDS),
    numRef: Number(String(input.numRef ?? numRefFor(input.metadata?.reference || '')).replace(/\D/g, '').slice(0, 7)) || 1,
    bankAccountId: input.bankAccountId,
    metadata: input.metadata || {},
  };
}
const pushBody = (input) => {
  const { amount, ...rest } = chargeBody(input);
  return { amount, phoneNumber: tenDigitPhone(input.phone), ...rest };
};

// Verified payload -> one of:
//   {id, type:'payment', event, transactionId, amount, metadata}   codi.{pn,qr}.payment_received
//   {id, type:'bank_account', event, bankAccountId, codiStatus}    bank.account.updated
//   {id, type:'ignored', event}                                    anything else
// `id` is the webhook-id header, used for deduplication. Fields are read defensively.
function normalizeEvent(id, body) {
  const event = String(body?.type || body?.event || body?.eventType || '');
  const nested = body?.data ?? body?.payload;
  const data = nested && typeof nested === 'object' ? nested : body || {};
  if (event === 'codi.pn.payment_received' || event === 'codi.qr.payment_received') {
    const transactionId = data.transactionId ?? data.transaction?.id ?? null;
    return {
      id, type: 'payment', event,
      transactionId: transactionId === null ? null : String(transactionId),
      amount: data.amount ?? null,
      metadata: data.metadata?.externalMetadata || null,
    };
  }
  if (event === 'bank.account.updated') {
    const account = data.bankAccount || data.account || data;
    const bankAccountId = account.bankAccountId ?? account.id ?? data.bankAccountId ?? null;
    const codiStatus = String(account.codiStatus ?? data.codiStatus ?? '').toUpperCase();
    return {
      id, type: 'bank_account', event,
      bankAccountId: bankAccountId === null ? null : String(bankAccountId),
      codiStatus: CODI_STATUSES.has(codiStatus) ? codiStatus : null,
    };
  }
  return { id, type: 'ignored', event };
}

// Standard Webhooks verification over the raw body (never re-serialized).
function verifyWebhook(secret, headers, rawBody) {
  if (!secret) throw new PeyWebhookError('webhook secret not configured');
  const picked = {};
  for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
    const value = headers?.[name];
    picked[name] = Array.isArray(value) ? value[0] : value;
    if (!picked[name]) throw new PeyWebhookError('missing webhook headers');
  }
  let body;
  try {
    body = new Webhook(secret).verify(rawBody, picked);
  } catch {
    throw new PeyWebhookError('bad signature');
  }
  return normalizeEvent(picked['webhook-id'], body);
}

export class HttpPeyClient {
  constructor({ apiUrl, apiKey, webhookSecret, fetchImpl = globalThis.fetch }) {
    this.apiUrl = (apiUrl || PEY_API_BASE).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.webhookSecret = webhookSecret;
    this.fetch = fetchImpl;
  }

  async request(method, path, body) {
    const headers = { authorization: `Bearer ${this.apiKey}`, accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await this.fetch(`${this.apiUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (err) {
      log.error('pey.request.error', { method, path, error: err?.message });
      throw new PeyApiError(`pey ${method} ${path} failed: network`, 0);
    }
    if (!res.ok) {
      log.error('pey.request.error', { method, path, status: res.status });
      throw new PeyApiError(`pey ${method} ${path} failed: ${res.status}`, res.status);
    }
    return res.json();
  }

  async createBankAccount({ alias, name, clabe, entity = 'PERSON' }) {
    const data = await this.request('POST', '/bank-account', { alias, name, clabe, entity });
    return { id: data.id, codiStatus: data.codiStatus };
  }

  async getBankAccount(id) {
    const data = await this.request('GET', `/bank-account/${encodeURIComponent(id)}`);
    return { id: data.id ?? id, codiStatus: data.codiStatus };
  }

  async createPushCharge(input) {
    const data = await this.request('POST', '/codi/pn', pushBody(input));
    return { transactionId: data.transactionId, codiId: data.codiId ?? null };
  }

  async createQrCharge(input) {
    const data = await this.request('POST', '/codi/qr', chargeBody(input));
    return { transactionId: data.transactionId ?? null, codiId: data.codiId ?? null, qrString: data.qrString ?? null };
  }

  async getTransaction(id) {
    const data = await this.request('GET', `/transaction/${encodeURIComponent(id)}`);
    return { transactionId: data.transactionId ?? data.id ?? id, status: String(data.status || '').toUpperCase() === 'PAID' ? 'PAID' : 'PENDING' };
  }

  parseWebhook({ headers, rawBody }) {
    return verifyWebhook(this.webhookSecret, headers, rawBody);
  }
}

// Mock for tests and local runs. Same interface, no network. It records what the real API
// would receive and builds Standard Webhooks-signed requests for the webhook endpoint.
export class MockPeyClient {
  constructor({ webhookSecret } = {}) {
    this.webhookSecret = webhookSecret || `whsec_${Buffer.from('coperacha-mock-secret').toString('base64')}`;
    this.bankAccounts = new Map();
    this.charges = [];
    this.failNextBankAccount = false;
    this.failNextPush = false;
    this.failNextQr = false;
    this.webhookSeq = 0;
  }

  async createBankAccount({ alias, name, clabe, entity = 'PERSON' }) {
    if (this.failNextBankAccount) {
      this.failNextBankAccount = false;
      throw new PeyApiError('pey mock: simulated bank account failure', 500);
    }
    if (!/^\d{18}$/.test(String(clabe))) throw new PeyApiError('pey mock: invalid clabe', 400);
    const id = `mock_ba_${this.bankAccounts.size + 1}`;
    const codiStatus = isPreauthorizedClabe(clabe) ? 'ACTIVE' : 'PENDING';
    this.bankAccounts.set(id, { id, alias, name, clabe, entity, codiStatus });
    return { id, codiStatus };
  }

  async getBankAccount(id) {
    const account = this.bankAccounts.get(id);
    if (!account) throw new PeyApiError('pey mock: bank account not found', 404);
    return { id, codiStatus: account.codiStatus };
  }

  // Test helper: what Pey does on its side when it reviews an account.
  setBankAccountStatus(id, codiStatus) {
    const account = this.bankAccounts.get(id);
    if (!account) throw new Error(`pey mock: unknown bank account ${id}`);
    account.codiStatus = codiStatus;
    return account;
  }

  record(kind, body, extra = {}) {
    const account = this.bankAccounts.get(body.bankAccountId);
    if (!account || account.codiStatus !== 'ACTIVE') throw new PeyApiError('pey mock: bank account is not active', 400);
    const transactionId = `mock_tx_${this.charges.length + 1}`;
    const charge = { transactionId, kind, status: 'PENDING', ...body, ...extra };
    this.charges.push(charge);
    return charge;
  }

  async createPushCharge(input) {
    const body = pushBody(input);
    if (this.failNextPush) {
      this.failNextPush = false;
      throw new PeyApiError('pey mock: simulated push failure', 500);
    }
    const charge = this.record('pn', body, { codiId: `mock_codi_${this.charges.length + 1}` });
    return { transactionId: charge.transactionId, codiId: charge.codiId };
  }

  async createQrCharge(input) {
    const body = chargeBody(input);
    if (this.failNextQr) {
      this.failNextQr = false;
      throw new PeyApiError('pey mock: simulated qr failure', 500);
    }
    const charge = this.record('qr', body, { qrString: `MOCKQR${this.charges.length + 1}` });
    return { transactionId: charge.transactionId, codiId: null, qrString: charge.qrString };
  }

  async getTransaction(id) {
    const charge = this.charges.find((c) => c.transactionId === id);
    if (!charge) throw new PeyApiError('pey mock: transaction not found', 404);
    return { transactionId: id, status: charge.status };
  }

  // Test helper: the payer accepted the charge in their bank app.
  markPaid(transactionId) {
    const charge = this.charges.find((c) => c.transactionId === transactionId);
    if (!charge) throw new Error(`pey mock: unknown transaction ${transactionId}`);
    charge.status = 'PAID';
    return charge;
  }

  parseWebhook({ headers, rawBody }) {
    return verifyWebhook(this.webhookSecret, headers, rawBody);
  }

  // Builds the request Pey would send: Standard Webhooks headers over the exact raw body.
  webhookRequest(type, data, { id, timestamp = new Date() } = {}) {
    this.webhookSeq += 1;
    const webhookId = id || `msg_mock_${this.webhookSeq}_${crypto.randomBytes(6).toString('hex')}`;
    const rawBody = JSON.stringify({ type, timestamp: timestamp.toISOString(), data });
    return {
      headers: {
        'content-type': 'application/json',
        'webhook-id': webhookId,
        'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
        'webhook-signature': new Webhook(this.webhookSecret).sign(webhookId, timestamp, rawBody),
      },
      rawBody,
    };
  }

  // Marks the mock transaction paid and returns the signed payment_received request.
  paymentWebhook(transactionId, options) {
    const charge = this.markPaid(transactionId);
    return this.webhookRequest(`codi.${charge.kind}.payment_received`, {
      transactionId, amount: charge.amount, metadata: { externalMetadata: charge.metadata },
    }, options);
  }

  // Flips the mock account and returns the signed bank.account.updated request.
  bankAccountWebhook(bankAccountId, codiStatus, options) {
    this.setBankAccountStatus(bankAccountId, codiStatus);
    return this.webhookRequest('bank.account.updated', { id: bankAccountId, codiStatus }, options);
  }
}
