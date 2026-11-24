import { appendFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { catalogs } from './catalog.js';
import { OllyxError } from './errors.js';

const ERROR_CODES = new Set([
  'internal_error', 'network_error', 'not_configured', 'scope_denied', 'upstream_error',
  'redirect_blocked', 'rate_limited', 'response_interrupted', 'response_too_large',
  'invalid_response', 'invalid_provider', 'invalid_path', 'forbidden_path',
  'unknown_read_endpoint', 'invalid_params', 'forbidden_parameter',
  'invalid_parameter_value', 'read_side_effect', 'query_too_large', 'invalid_headers',
  'reconnect_required', 'shared_connection_unavailable', 'missing_database',
  'invalid_token_file', 'oauth_busy', 'oauth_failed', 'oauth_unavailable',
]);
const ROUTES = Object.fromEntries(Object.entries(catalogs).map(([provider, catalog]) => [
  provider, catalog.resources.map(({ path }) => ({
    path,
    segments: path.split('/'),
  })),
]));

/** Log the route template, never identifiers, query values or arbitrary URL text. */
export function safeEndpoint(provider, path) {
  if (typeof path !== 'string') return '/unlisted';
  const segments = path.split('/');
  return ROUTES[provider]?.find(route => route.segments.length === segments.length
    && route.segments.every((segment, i) => /^\{\w+\}$/.test(segment)
      ? /^[A-Za-z0-9_,~-]+$/.test(segments[i]) : segment === segments[i]))?.path ?? '/unlisted';
}

export function apiLogFile(directory, date = new Date()) {
  return join(directory, `api-${date.toISOString().slice(0, 10)}.jsonl`);
}

/** Metadata only. A logging failure must not fail a business query. */
export function createApiLogger({ directory, enabled = true, write = line => process.stderr.write(line), now = () => new Date() } = {}) {
  let pending = Promise.resolve();
  let warned = false;
  const writeSafely = line => { try { write(line); } catch { /* logging is best effort */ } };
  return {
    record(event) {
      if (!enabled) return;
      const date = now();
      const entry = {
        timestamp: date.toISOString(),
        event: event.event === 'api_error' ? 'api_error' : 'api_request',
        requestId: /^[a-f\d-]{36}$/i.test(event.requestId) ? event.requestId : undefined,
        provider: ['bling', 'meli'].includes(event.provider) ? event.provider : 'unknown',
        method: 'GET',
        endpoint: safeEndpoint(event.provider, event.path),
        attempt: Number.isInteger(event.attempt) ? event.attempt : undefined,
        status: Number.isInteger(event.status) ? event.status : null,
        durationMs: Math.max(0, Math.round(Number(event.durationMs) || 0)),
        error: event.error ? (ERROR_CODES.has(event.error) ? event.error : 'internal_error') : undefined,
      };
      const line = JSON.stringify(entry) + '\n';
      writeSafely(line);
      if (directory) pending = pending.then(async () => {
        await mkdir(directory, { recursive: true });
        await appendFile(apiLogFile(directory, date), line, { mode: 0o600 });
      }).catch(() => {
        if (!warned) writeSafely('{"event":"api_log_unavailable","message":"Não foi possível gravar o log local; consulte o stderr."}\n');
        warned = true;
      });
    },
    flush: () => pending,
  };
}

/** Read a bounded tail, even when the daily file is large. */
export async function readApiLogs(directory, limit = 20, date = new Date()) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new OllyxError('invalid_log_limit', 'Informe de 1 a 200 linhas de log.');
  let file;
  try {
    file = await open(apiLogFile(directory, date), 'r');
    const { size } = await file.stat();
    const start = Math.max(0, size - 256 * 1024);
    const buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').trimEnd().split('\n');
    if (start) lines.shift();
    return lines.filter(Boolean).slice(-limit).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  } finally { await file?.close(); }
}
