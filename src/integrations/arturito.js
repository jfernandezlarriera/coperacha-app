// Arturito client (this app is a client of the Arturito WhatsApp bot).
//
// send:       POST   ARTURITO_SEND_URL           {chatId, type:"text", text}
//             202 queued | 403 chat not allowed | 503 whatsapp_disconnected (retry later)
// register:   POST   ARTURITO_SEND_URL/registry  {chatId}
// unregister: DELETE ARTURITO_SEND_URL/registry  {chatId}
//
// All three use Authorization: Bearer ARTURITO_SEND_KEY. The registry tells Arturito to
// route inbound 1:1 messages from that chatId to this app's webhook. Arturito matches the
// chatId exactly (no 52 vs 521 normalization), so a Mexican number is registered under both
// JID forms (see `registryChatIds`). If the URL or the key is unset we log and go on.
import { log } from '../logger.js';
import { registryChatIds } from '../util/phone.js';

export function registryUrl(sendUrl) {
  return `${String(sendUrl).replace(/\/+$/, '')}/registry`;
}

export class HttpArturitoClient {
  constructor({ sendUrl, sendKey, fetchImpl = globalThis.fetch }) {
    this.sendUrl = sendUrl;
    this.sendKey = sendKey;
    this.fetch = fetchImpl;
  }

  async send({ chatId, text }) {
    if (!this.sendUrl) {
      log.warn('arturito.send.skipped', { chatId, reason: 'no_send_url' });
      return { status: 0, skipped: true };
    }
    const res = await this.fetch(this.sendUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.sendKey}` },
      body: JSON.stringify({ chatId, type: 'text', text }),
    });
    return { status: res.status };
  }

  register({ phone, role, colectaId }) {
    return this.#registry('POST', 'arturito.register', { phone, role, colectaId });
  }

  unregister({ phone, role, colectaId }) {
    return this.#registry('DELETE', 'arturito.unregister', { phone, role, colectaId });
  }

  // Never throws: a registry failure must not break creating or joining a colecta.
  // `status` is the worst (highest) HTTP status across the chatIds, 0 when nothing was sent.
  async #registry(method, event, { phone, role, colectaId }) {
    if (!this.sendUrl || !this.sendKey) {
      const reason = this.sendUrl ? 'no_send_key' : 'no_send_url';
      log.info(`${event}.skipped`, { role, colectaId, reason });
      return { status: 0, skipped: true };
    }
    const chatIds = registryChatIds(phone);
    if (!chatIds.length) {
      log.warn(`${event}.skipped`, { role, colectaId, reason: 'no_chat_id' });
      return { status: 0, skipped: true };
    }
    const url = registryUrl(this.sendUrl);
    let status = 0;
    let error = false;
    for (const chatId of chatIds) {
      try {
        const res = await this.fetch(url, {
          method,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.sendKey}` },
          body: JSON.stringify({ chatId }),
        });
        log.info(event, { status: res.status, chatId, role, colectaId });
        status = Math.max(status, res.status);
      } catch (err) {
        log.error(`${event}.error`, { error: err?.message, chatId, colectaId });
        error = true;
      }
    }
    return error ? { status, chatIds, error: true } : { status, chatIds };
  }
}

// Records calls; `respondWith` lets tests simulate 202/403/503 per call.
export class MockArturitoClient {
  constructor() {
    this.sends = [];
    this.registrations = [];
    this.unregistrations = [];
    this.responses = [];
  }

  respondWith(status) {
    this.responses.push(status);
  }

  async send({ chatId, text }) {
    this.sends.push({ chatId, text });
    const status = this.responses.length ? this.responses.shift() : 202;
    return { status };
  }

  async register({ phone, role, colectaId }) {
    const chatIds = registryChatIds(phone);
    this.registrations.push({ phone, role, colectaId, chatIds });
    return { status: 200, chatIds };
  }

  async unregister({ phone, role, colectaId }) {
    const chatIds = registryChatIds(phone);
    this.unregistrations.push({ phone, role, colectaId, chatIds });
    return { status: 200, chatIds };
  }
}
