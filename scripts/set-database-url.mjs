// Assistente: lê a connection string do Supabase (sem mostrar), corrige a codificação da senha, TESTA a conexão
// e só então grava OLLYX_DATABASE_URL na Vercel.
// Uso: node scripts/set-database-url.mjs            (cola no prompt escondido)
//      node scripts/set-database-url.mjs --clipboard (lê da área de transferência; limpa ao terminar com sucesso)
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const enc = encodeURIComponent;
const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };

/** Interpreta postgres://usuario:senha@host:porta/banco mesmo quando a senha tem @, / ou #. Nunca devolve a senha em texto de log. */
export function parseConnectionString(input) {
  const all = String(input || '');
  const start = all.search(/postgres(?:ql)?:\/\//); // tolera texto antes/depois (ex.: copiou a frase inteira)
  const raw = start < 0 ? all.trim() : all.slice(start).trim().split(/\s/)[0];
  const m = /^postgres(?:ql)?:\/\/([\s\S]+)$/.exec(raw);
  if (!m) throw new Error('O texto precisa começar com postgresql://');
  const rest = m[1], at = rest.lastIndexOf('@');
  if (at < 1) throw new Error('Não encontrei o "@" que separa a senha do servidor.');
  const userinfo = rest.slice(0, at), hostinfo = rest.slice(at + 1);
  const colon = userinfo.indexOf(':');
  if (colon < 1) throw new Error('Não encontrei usuário e senha (formato usuario:senha).');
  const user = safeDecode(userinfo.slice(0, colon)), password = safeDecode(userinfo.slice(colon + 1));
  if (/^\[?YOUR-PASSWORD\]?$/i.test(password)) throw new Error('Você deixou o texto [YOUR-PASSWORD]: troque pela senha real do banco.');
  const h = /^([^:/?#]+)(?::(\d+))?(?:\/([^?]*))?(?:\?.*)?$/.exec(hostinfo);
  if (!h) throw new Error('Não consegui ler o servidor depois do "@".');
  const host = h[1], port = Number(h[2] || 5432), database = h[3] || 'postgres';
  if (!host.includes('.')) throw new Error(`O servidor lido foi "${host}", que não parece um endereço. Provavelmente a senha tem caracteres especiais ou o texto está incompleto.`);
  return { user, password, host, port, database, url: `postgresql://${enc(user)}:${enc(password)}@${host}:${port}/${database}` };
}

const PS = ['-NoProfile', '-NonInteractive', '-Command'];
function readClipboard() {
  const r = spawnSync('powershell.exe', [...PS, 'Get-Clipboard -Raw'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('Não consegui ler a área de transferência.');
  return r.stdout;
}
const clearClipboard = () => spawnSync('powershell.exe', [...PS, "Set-Clipboard -Value ' '"], { stdio: 'ignore' });

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin; let value = '';
    stdin.setRawMode?.(true); stdin.resume(); stdin.setEncoding('utf8');
    const done = fn => { stdin.setRawMode?.(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); fn(); };
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(value));
        if (ch === '\u0003') return done(() => reject(new Error('Cancelado.')));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1); else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const clip = process.argv.includes('--clipboard');
  const text = clip ? readClipboard() : await readHidden('Cole a connection string do Supabase (nada aparece na tela) e aperte Enter: ');
  let c;
  try { c = parseConnectionString(text); }
  catch (e) {
    if (clip) console.log(`Diagnóstico da área de transferência: ${text.length} caracteres; contém "postgres": ${/postgres/i.test(text)}; contém "@": ${text.includes('@')}; contém "supabase": ${/supabase/i.test(text)}.`);
    throw e;
  }
  console.log(`Lido: servidor=${c.host} porta=${c.port} usuário=${c.user} banco=${c.database} (senha: ${c.password.length} caracteres)`);
  if (c.host.startsWith('db.')) console.log('AVISO: este é o endereço direto (IPv6). Na Vercel use o "Transaction pooler" (…pooler.supabase.com, porta 6543).');
  const client = new pg.Client({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  try { await client.connect(); const r = await client.query('select current_user as u, (select count(*) from mcp.users) as usuarios'); console.log(`Conexão OK como ${r.rows[0].u}; usuários no MCP: ${r.rows[0].usuarios}`); }
  catch (e) { throw new Error(`Falha ao conectar (${e.code || e.message}). Nada foi gravado na Vercel.`); }
  finally { await client.end().catch(() => {}); }
  spawnSync('npx.cmd', ['vercel', 'env', 'rm', 'OLLYX_DATABASE_URL', 'production', '--yes'], { stdio: 'ignore', shell: true });
  const add = spawnSync('npx.cmd', ['vercel', 'env', 'add', 'OLLYX_DATABASE_URL', 'production', '--sensitive'], { input: c.url, shell: true, encoding: 'utf8' });
  if (add.status !== 0) throw new Error('A Vercel recusou gravar a variável. Rode "npx.cmd vercel login" e tente de novo.');
  if (clip) { clearClipboard(); console.log('Área de transferência limpa.'); }
  console.log('Pronto: OLLYX_DATABASE_URL gravada na Vercel (sensível). Avise o assistente para fazer o redeploy.');
}

if (import.meta.url === new URL(process.argv[1], 'file:///').href.replace('file:////', 'file:///') || process.argv[1]?.endsWith('set-database-url.mjs')) {
  main().catch(e => { console.error('Erro: ' + e.message); process.exitCode = 1; });
}
