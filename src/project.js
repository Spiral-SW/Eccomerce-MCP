import { OllyxError } from './errors.js';

/**
 * Projeção de campos: devolve só os caminhos pedidos (ex.: "id", "codigo", "estoque.saldoVirtualTotal",
 * "order_items.item.id"). Atravessa arrays; caminhos inexistentes são ignorados. Serve para as consultas genéricas
 * não encherem a conversa com campos enormes (descrições HTML, imagens, tributação...).
 */
const PATH = /^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/;
export function validatePaths(paths) {
  for (const p of paths) if (!PATH.test(p)) throw new OllyxError('invalid_fields', 'Campo inválido: use caminhos como "id" ou "estoque.saldoVirtualTotal".');
  return paths.map(p => p.split('.'));
}
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function pickOne(src, segs) {
  if (Array.isArray(src)) { const arr = src.map(e => pickOne(e, segs)); return arr.some(e => e !== undefined) ? arr : undefined; }
  if (!isObj(src)) return undefined;
  const [head, ...rest] = segs;
  if (!Object.hasOwn(src, head)) return undefined;
  if (!rest.length) return { [head]: src[head] };
  const inner = pickOne(src[head], rest);
  return inner === undefined ? undefined : { [head]: inner };
}
function merge(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => merge(x, b[i]));
  if (isObj(a) && isObj(b)) { const out = { ...a }; for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v; return out; }
  return b;
}
export function pickPaths(item, segsList) {
  let out;
  for (const segs of segsList) out = merge(out, pickOne(item, segs));
  return out === undefined ? (Array.isArray(item) ? [] : {}) : out;
}

/** Aplica a projeção ao formato de resposta de cada API: Bling {data}, Meli {results,paging} ou objeto/array simples. */
export function projectData(data, paths) {
  if (!paths?.length) return data;
  const segs = validatePaths(paths);
  const each = arr => arr.map(item => pickPaths(item, segs));
  if (Array.isArray(data)) return each(data);
  if (!isObj(data)) return data;
  if (Array.isArray(data.data)) return { ...data, data: each(data.data) };
  if (isObj(data.data)) return { ...data, data: pickPaths(data.data, segs) };
  if (Array.isArray(data.results)) return { ...data, results: each(data.results) };
  return pickPaths(data, segs);
}
/** Projeta as respostas de ollyx_consultar / ollyx_consultar_paginas sem tocar nos metadados (paging, status...). */
export function projectResult(result, paths) {
  if (!paths?.length) return result;
  validatePaths(paths);
  if (Array.isArray(result.pages)) return { ...result, pages: result.pages.map(p => ({ ...p, data: projectData(p.data, paths) })), camposAplicados: paths };
  return { ...result, data: projectData(result.data, paths), camposAplicados: paths };
}
