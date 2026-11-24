import { pathToFileURL } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from './config.js';
import { oauth, grantToken, saveToken, withFileLock } from './tokens.js';
import { OllyxError, publicError } from './errors.js';

export function authorizationRequest(provider, config) {
  if (!config.clientId || !config.clientSecret || !config.redirectUri) throw new OllyxError('missing_oauth_config', 'Preencha CLIENT_ID, CLIENT_SECRET e REDIRECT_URI do provedor no arquivo .env local.');
  let redirect;
  try { redirect = new URL(config.redirectUri); } catch { throw new OllyxError('invalid_redirect', 'REDIRECT_URI precisa ser uma URL válida.'); }
  if (!['https:', 'http:'].includes(redirect.protocol) || redirect.username || redirect.password || redirect.hash) throw new OllyxError('invalid_redirect', 'REDIRECT_URI inválido.');
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const url = new URL(oauth[provider].authorize);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, state,
    ...(provider === 'meli' ? {
      scope: 'read offline_access', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    } : {}),
  });
  return { url: url.href, state, verifier };
}
export function callbackCode(input, expectedState, redirectUri) {
  let callback;
  try { callback = new URL(input); } catch { throw new OllyxError('invalid_callback', 'Cole a URL completa do redirecionamento.'); }
  const expected = new URL(redirectUri);
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.username || callback.password || callback.hash) throw new OllyxError('invalid_callback', 'O callback difere do REDIRECT_URI configurado.');
  if (callback.searchParams.getAll('state').length !== 1 || callback.searchParams.getAll('code').length !== 1) throw new OllyxError('invalid_callback', 'Callback sem state/code únicos.');
  const actual = Buffer.from(callback.searchParams.get('state') || '');
  const wanted = Buffer.from(expectedState);
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new OllyxError('state_mismatch', 'O estado OAuth não corresponde a esta autorização.');
  const code = callback.searchParams.get('code');
  if (!code || callback.searchParams.has('error')) throw new OllyxError('authorization_denied', 'A autorização não foi concluída.');
  return code;
}
export async function main() {
  const provider = process.argv[2];
  if (!['bling', 'meli'].includes(provider)) throw new OllyxError('invalid_provider', 'Uso: npm run auth -- bling OU npm run auth -- meli');
  const app = loadConfig();
  const config = app.providers[provider];
  if (config.useDatabase || config.accessToken || config.sharedEnvFile) throw new OllyxError('credential_mode_conflict', 'Desative o token de ambiente/modo banco para usar OAuth próprio do MCP.');
  const request = authorizationRequest(provider, config);
  console.log('Abra este endereço no navegador e autorize sua própria conta:\n' + request.url);
  console.log('Após redirecionar, cole a URL completa SOMENTE neste terminal local.');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let input;
  try { input = await terminal.question('URL do callback: '); } finally { terminal.close(); }
  const code = callbackCode(input.trim(), request.state, config.redirectUri);
  const form = { grant_type: 'authorization_code', code, redirect_uri: config.redirectUri };
  if (provider === 'meli') form.code_verifier = request.verifier;
  await withFileLock(config.tokenFile, async () => {
    const token = await grantToken(provider, config, form, fetch, app.timeoutMs);
    await saveToken(config.tokenFile, token);
  });
  console.log('Conexão salva localmente. Nenhum token foi exibido.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(publicError(error).message); process.exitCode = 1; });
}
