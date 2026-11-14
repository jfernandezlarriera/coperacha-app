// Arturito client (this app is a client of the Arturito WhatsApp bot).
//
// send:     POST ARTURITO_SEND_URL  {chatId, type:"text", text}  Authorization: Bearer ARTURITO_SEND_KEY
//           202 queued | 403 chat not allowed | 503 whatsapp_disconnected (retry later)
// register: POST ARTURITO_REGISTER_URL {phone, chatId, app:"coperacha"}  Bearer ARTURITO_REGISTER_TOKEN
//           Tells Arturito to route inbound 1:1 messages from that number to this app's
//           webhook. The registry API may still be landing on the Arturito side; the shape
//           above is this app's assumption (see README). If the URL is unset we log and go on.
import { log } from '../logger.js';
import { chatIdForPhone } from '../util/phone.js';

export class HttpArturitoClient {
  constructor({ sendUrl, sendKey, registerUrl, registerToken, fetchImpl = globalThis.fetch }) {
    this.sendUrl = sendUrl;
    this.sendKey = sendKey;
    this.registerUrl = registerUrl;
    this.registerToken = registerToken;
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

  async register({ phone, role, colectaId }) {
    if (!this.registerUrl) {
      log.info('arturito.register.skipped', { role, colectaId, reason: 'no_register_url' });
      return { status: 0, skipped: true };
    }
    try {
      const res = await this.fetch(this.registerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.registerToken}` },
        body: JSON.stringify({ phone, chatId: chatIdForPhone(phone), app: 'coperacha', role }),
      });
      log.info('arturito.register', { status: res.status, role, colectaId });
      return { status: res.status };
    } catch (err) {
      log.error('arturito.register.error', { error: err?.message, colectaId });
      return { status: 0, error: true };
    }
  }
}

// Records calls; `respondWith` lets tests simulate 202/403/503 per call.
export class MockArturitoClient {
  constructor() {
    this.sends = [];
    this.registrations = [];
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
    this.registrations.push({ phone, role, colectaId });
    return { status: 200 };
  }
}
