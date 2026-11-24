import { OllyxError } from './errors.js';
export async function readLimited(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new OllyxError('response_too_large', 'A resposta excedeu o limite. Use filtros, campos ou páginas menores.');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new OllyxError('response_too_large', 'A resposta excedeu o limite. Use filtros, campos ou páginas menores.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
const sensitive = /^(access_token|refresh_token|client_secret|authorization|password|senha|secret|api_key)$/i;
export function redact(value, knownSecrets = []) {
  if (Array.isArray(value)) return value.map(v => redact(v, knownSecrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sensitive.test(k) ? '[REDACTED]' : redact(v, knownSecrets)]));
  }
  if (typeof value === 'string') {
    for (const secret of knownSecrets.filter(s => s && s.length > 5)) value = value.split(secret).join('[REDACTED]');
  }
  return value;
}
