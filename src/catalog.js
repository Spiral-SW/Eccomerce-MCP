import { readFileSync } from 'node:fs';
import { OllyxError } from './errors.js';
const read = name => JSON.parse(readFileSync(new URL('../catalog/' + name + '.json', import.meta.url), 'utf8'));
export const catalogs = { bling: read('bling'), meli: read('meli') };
export function findResources(provider, search = '', offset = 0, limit = 20) {
  const selected = provider ? [provider] : ['bling', 'meli'];
  const normalize = s => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const query = normalize(search);
  const resources = selected.flatMap(p => catalogs[p].resources.map(r => ({ provider: p, ...r })))
    .filter(r => normalize(JSON.stringify(r)).includes(query));
  return {
    total: resources.length, offset, limit, resources: resources.slice(offset, offset + limit),
    nextOffset: offset + limit < resources.length ? offset + limit : null,
    coverage: Object.fromEntries(selected.map(p => [p, catalogs[p].coverage])),
  };
}
const patterns = catalogs.bling.resources.map(r => new RegExp('^' + r.path.split('/').map(segment =>
  /^\{\w+\}$/.test(segment) ? '[A-Za-z0-9_,~-]+' : segment.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
).join('/') + '$'));
export function validateQuery(provider, path, params = {}) {
  if (!['bling', 'meli'].includes(provider)) throw new OllyxError('invalid_provider', 'Provedor inválido.');
  if (typeof path !== 'string' || path.length > 2048 || !/^\/[A-Za-z0-9_.,~/-]+$/.test(path)
    || path.includes('//') || path.split('/').some(s => s === '.' || s === '..') || path.endsWith('/')) {
    throw new OllyxError('invalid_path', 'Use um caminho relativo, sem URL, query, escapes ou segmentos de navegação.');
  }
  if (/(?:^|\/)(?:oauth|auth|authorization|logout|revoke|revoke_token)(?:\/|$)/i.test(path)) {
    throw new OllyxError('forbidden_path', 'Endpoints de autenticação não são consultas de negócio.');
  }
  if (provider === 'bling' && !patterns.some(p => p.test(path))) {
    throw new OllyxError('unknown_read_endpoint', 'O caminho não consta no catálogo GET do Bling. Consulte ollyx_recursos.');
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new OllyxError('invalid_params', 'Filtros devem ser um objeto.');
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (!/^[A-Za-z0-9_.\[\]-]+$/.test(key)
      || /^(access_token|refresh_token|token|authorization|client_secret|password|callback|_method|method|http_method)$/i.test(key)) {
      throw new OllyxError('forbidden_parameter', 'Parâmetro de consulta não permitido.');
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!['string', 'number', 'boolean'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item))) {
        throw new OllyxError('invalid_parameter_value', 'Filtros aceitam texto, número, booleano ou listas desses valores.');
      }
      query.append(key, String(item));
    }
  }
  if (provider === 'meli' && path.startsWith('/messages/')) {
    for (const key of query.keys()) {
      if (key.toLowerCase().replace(/\[\]/g, '') === 'mark_as_read' && key !== 'mark_as_read') {
        throw new OllyxError('forbidden_parameter', 'Use somente mark_as_read=false.');
      }
    }
    if (query.getAll('mark_as_read').some(v => v !== 'false')) throw new OllyxError('read_side_effect', 'Marcar mensagens como lidas é bloqueado.');
    query.set('mark_as_read', 'false');
  }
  if (query.toString().length > 16000) throw new OllyxError('query_too_large', 'Reduza os filtros da consulta.');
  return query;
}
