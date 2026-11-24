import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readJson, writeJsonAtomic, writeTextAtomic } from './cache.js';
import { OllyxError } from './errors.js';

const KEY = /^[A-Za-z0-9._-]{1,200}$/;
const checkKey = key => { if (!KEY.test(key)) throw new OllyxError('invalid_store_key', 'Chave de cache inválida.'); return key; };

/**
 * Armazenamento de cache e exportações. Duas implementações com a mesma interface:
 *  - FileStore: disco local (modo stdio); chaves viram `<dir>/cache/<chave>.json`.
 *  - PgStore: tabela `mcp.kv` no Postgres (modo em rede, onde não há disco persistente).
 * Interface: get(key), set(key, value, {ttlMs}), putExport(name, text) -> {arquivo}|{download}, withLock(name, fn).
 */
export class FileStore {
  constructor(dir) { this.dir = dir; this.locks = new Map(); }
  async get(key) { return readJson(resolve(this.dir, 'cache', checkKey(key) + '.json')); }
  async getMany(keys) {
    const entries = await Promise.all(keys.map(async k => [k, await this.get(k)]));
    return new Map(entries.filter(([, v]) => v != null));
  }
  async set(key, value) { await writeJsonAtomic(resolve(this.dir, 'cache', checkKey(key) + '.json'), value); }
  async del(key) { await rm(resolve(this.dir, 'cache', checkKey(key) + '.json'), { force: true }); }
  async putExport(name, text) {
    const arquivo = resolve(this.dir, 'exports', checkKey(name));
    await writeTextAtomic(arquivo, text);
    return { arquivo };
  }
  /** Exclusão mútua dentro do processo (suficiente para um único servidor local). */
  async withLock(name, fn) {
    const previous = this.locks.get(name) || Promise.resolve();
    let release; const mine = new Promise(r => { release = r; });
    this.locks.set(name, previous.then(() => mine));
    await previous;
    try { return await fn(); } finally { release(); if (this.locks.get(name) === mine) this.locks.delete(name); }
  }
}

export class PgStore {
  /** `pool` precisa de query(text, params) e connect() (pg.Pool). `exportBase` é o prefixo público das exportações. */
  constructor(pool, { exportBase = '/api/exports', exportTtlMs = 24 * 3600e3, signer = null } = {}) {
    this.pool = pool; this.exportBase = exportBase; this.exportTtlMs = exportTtlMs; this.signer = signer; // signer(name) -> URL de download assinada
  }
  async del(key) { await this.pool.query('DELETE FROM mcp.kv WHERE key = $1', [checkKey(key)]); }
  async get(key) {
    const { rows } = await this.pool.query('SELECT value FROM mcp.kv WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())', [checkKey(key)]);
    return rows[0]?.value ?? null;
  }
  /** Várias chaves em UMA consulta (ida e volta ao banco é o custo dominante em ambiente serverless). */
  async getMany(keys) {
    if (!keys.length) return new Map();
    keys.forEach(checkKey);
    const { rows } = await this.pool.query('SELECT key, value FROM mcp.kv WHERE key = ANY($1::text[]) AND (expires_at IS NULL OR expires_at > now())', [keys]);
    return new Map(rows.map(r => [r.key, r.value]));
  }
  async set(key, value, { ttlMs } = {}) {
    await this.pool.query(
      `INSERT INTO mcp.kv (key, value, expires_at, updated_at) VALUES ($1, $2::jsonb, CASE WHEN $3::bigint IS NULL THEN NULL ELSE now() + ($3::bigint * interval '1 millisecond') END, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, updated_at = now()`,
      [checkKey(key), JSON.stringify(value), ttlMs ?? null]);
  }
  async putExport(name, text) {
    await this.set('export.' + checkKey(name), { text }, { ttlMs: this.exportTtlMs });
    return { download: this.signer ? this.signer(name) : `${this.exportBase}/${encodeURIComponent(name)}` };
  }
  async getExport(name) { return (await this.get('export.' + checkKey(name)))?.text ?? null; }
  /** Trava consultiva no Postgres, válida entre instâncias serverless; liberada ao fim da transação. */
  async withLock(name, fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [name]);
      const out = await fn();
      await client.query('COMMIT');
      return out;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
}
