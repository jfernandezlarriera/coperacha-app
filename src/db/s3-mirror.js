// Write-behind mirror of the store to one remote object (S3 in production). The Store stays
// synchronous: every persist() marks the mirror dirty and uploads run one at a time, always
// with the latest state, retrying with backoff while the remote is unavailable.
// Single writer only: run exactly one app instance against a given bucket/key.
import { log } from '../logger.js';

export class S3Mirror {
  constructor({ objects, retryMs = 2000, maxRetryMs = 60_000 }) {
    this.objects = objects;
    this.retryMs = retryMs;
    this.maxRetryMs = maxRetryMs;
    this.serialize = null;
    this.dirty = false;
    this.running = null;
    this.lastError = null;
  }

  attach(serialize) {
    this.serialize = serialize;
  }

  // Remote contents as a string, or null when the object does not exist yet. Throws on any
  // other failure so the caller never starts empty on top of existing data.
  load() {
    return this.objects.get();
  }

  markDirty() {
    this.dirty = true;
    if (!this.running) this.running = this.#drain();
  }

  async #drain() {
    let delay = this.retryMs;
    while (this.dirty) {
      this.dirty = false;
      try {
        await this.objects.put(this.serialize());
        this.lastError = null;
        delay = this.retryMs;
      } catch (err) {
        this.dirty = true;
        this.lastError = err;
        log.error('store.s3.put.error', { error: err?.name, status: err?.status, code: err?.code });
        await new Promise((resolve) => { setTimeout(resolve, delay); });
        delay = Math.min(delay * 2, this.maxRetryMs);
      }
    }
    this.running = null;
  }

  // Resolves once everything marked dirty so far has been uploaded.
  async flush() {
    while (this.running) await this.running;
  }
}
