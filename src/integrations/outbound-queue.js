// Throttled outbound queue for WhatsApp sends. Arturito caps sends at 6 per minute
// globally, so this app never bursts: a sliding window of `limitPerMinute` sends per 60 s.
// 503 (whatsapp_disconnected) retries after `retryDelayMs`; 403 (chat not allowed) drops.
import { log } from '../logger.js';

export class OutboundQueue {
  constructor({ client, limitPerMinute = 6, retryDelayMs = 30_000, maxRetries = 5, clock } = {}) {
    this.client = client;
    this.limit = limitPerMinute;
    this.retryDelayMs = retryDelayMs;
    this.maxRetries = maxRetries;
    this.clock = clock || { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) };
    this.pending = [];
    this.sentAt = [];
    this.timer = null;
    this.sent = [];
    this.dropped = [];
  }

  enqueue({ chatId, text }) {
    if (!chatId || !text) return;
    this.pending.push({ chatId, text, attempts: 0 });
    this.drain();
  }

  get size() {
    return this.pending.length;
  }

  windowStart() {
    return this.clock.now() - 60_000;
  }

  slotsAvailable() {
    const start = this.windowStart();
    this.sentAt = this.sentAt.filter((t) => t > start);
    return this.limit - this.sentAt.length;
  }

  drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0 && this.slotsAvailable() > 0) {
        const item = this.pending[0];
        if (item.notBefore && item.notBefore > this.clock.now()) break;
        this.pending.shift();
        this.sentAt.push(this.clock.now());
        this.dispatch(item);
      }
    } finally {
      this.draining = false;
    }
    this.schedule();
  }

  schedule() {
    if (this.timer) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const head = this.pending[0];
    let waitMs = 0;
    if (this.slotsAvailable() <= 0) waitMs = Math.max(waitMs, this.sentAt[0] + 60_000 - this.clock.now());
    if (head.notBefore) waitMs = Math.max(waitMs, head.notBefore - this.clock.now());
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.drain();
    }, Math.max(waitMs, 1));
  }

  dispatch(item) {
    Promise.resolve()
      .then(() => this.client.send({ chatId: item.chatId, text: item.text }))
      .then((result) => {
        if (result && result.status === 503) {
          item.attempts += 1;
          if (item.attempts > this.maxRetries) {
            this.dropped.push(item);
            log.warn('whatsapp.send.dropped', { chatId: item.chatId, reason: 'retries_exhausted' });
            return;
          }
          item.notBefore = this.clock.now() + this.retryDelayMs;
          this.pending.unshift(item);
          log.warn('whatsapp.send.retry', { chatId: item.chatId, attempt: item.attempts });
          this.schedule();
          return;
        }
        if (result && result.status === 403) {
          this.dropped.push(item);
          log.warn('whatsapp.send.not_allowed', { chatId: item.chatId });
          return;
        }
        this.sent.push(item);
        log.info('whatsapp.send.queued', { chatId: item.chatId });
      })
      .catch((err) => {
        this.dropped.push(item);
        log.error('whatsapp.send.error', { chatId: item.chatId, error: err?.message });
      });
  }

  // Lets tests await all in-flight dispatches.
  async settle() {
    await new Promise((r) => setImmediate(r));
  }
}
