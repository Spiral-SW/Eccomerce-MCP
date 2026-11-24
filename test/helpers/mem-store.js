/** Store em memória com a interface do PgStore (get/set/del/withLock/putExport/getExport); só para testes. */
export class MemStore {
  constructor({ signer = null } = {}) { this.data = new Map(); this.signer = signer; }
  async get(k) { const e = this.data.get(k); return e && (!e.exp || e.exp > Date.now()) ? e.value : null; }
  async getMany(keys) { const out = new Map(); for (const k of keys) { const v = await this.get(k); if (v != null) out.set(k, v); } return out; }
  async set(k, value, { ttlMs } = {}) { this.data.set(k, { value, exp: ttlMs ? Date.now() + ttlMs : 0 }); }
  async del(k) { this.data.delete(k); }
  async withLock(_, fn) { return fn(); }
  async putExport(name, text) { await this.set('export.' + name, { text }); return { download: this.signer ? this.signer(name) : '/api/exports/' + name }; }
  async getExport(name) { return (await this.get('export.' + name))?.text ?? null; }
}
