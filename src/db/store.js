// Single-file JSON store with a small repository API. Chosen so the MVP runs with zero
// native dependencies; the API (insert/get/find/update/all) is the seam to move to SQLite.
// Schema (collections and fields) is documented in src/db/schema.md.
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

export const COLLECTIONS = ['organizers', 'colectas', 'participants', 'proposals', 'votes', 'charges', 'webhookEvents'];

export class Store {
  // `remote` (optional, see s3-mirror.js) receives a copy of the data after each persist.
  constructor(filePath = ':memory:', { remote = null } = {}) {
    this.filePath = filePath;
    this.remote = remote;
    this.data = { schemaVersion: SCHEMA_VERSION };
    for (const c of COLLECTIONS) this.data[c] = [];
    this.load();
    this.remote?.attach(() => JSON.stringify(this.data, null, 1));
  }

  // Boot step when a remote is configured: the remote copy wins over the local file. If the
  // remote has no object yet, whatever was loaded locally is uploaded as the first copy.
  // Returns true when data came from the remote.
  async loadRemote() {
    if (!this.remote) return false;
    const raw = await this.remote.load();
    if (raw === null) {
      if (COLLECTIONS.some((c) => this.data[c].length)) this.remote.markDirty();
      return false;
    }
    this.data = migrate(JSON.parse(raw));
    this.writeLocal();
    return true;
  }

  // Resolves when pending remote uploads are done (no-op without a remote).
  async flush() {
    await this.remote?.flush();
  }

  get inMemory() {
    return this.filePath === ':memory:';
  }

  load() {
    if (this.inMemory || !fs.existsSync(this.filePath)) return;
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    this.data = migrate(raw);
  }

  persist() {
    this.writeLocal();
    this.remote?.markDirty();
  }

  writeLocal() {
    if (this.inMemory) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.filePath);
  }

  insert(collection, record) {
    this.data[collection].push(record);
    this.persist();
    return record;
  }

  get(collection, id) {
    return this.data[collection].find((r) => r.id === id) || null;
  }

  find(collection, predicate) {
    return this.data[collection].filter(predicate);
  }

  findOne(collection, predicate) {
    return this.data[collection].find(predicate) || null;
  }

  all(collection) {
    return this.data[collection].slice();
  }

  update(collection, id, patch) {
    const record = this.get(collection, id);
    if (!record) throw new Error(`${collection}:${id} not found`);
    Object.assign(record, patch);
    this.persist();
    return record;
  }

  remove(collection, id) {
    this.data[collection] = this.data[collection].filter((r) => r.id !== id);
    this.persist();
  }
}

// Forward-only migrations keyed by schemaVersion.
function migrate(raw) {
  const data = { ...raw };
  if (!data.schemaVersion) data.schemaVersion = 1;
  for (const c of COLLECTIONS) if (!Array.isArray(data[c])) data[c] = [];
  // Future: if (data.schemaVersion === 1) { ...; data.schemaVersion = 2; }
  return data;
}
