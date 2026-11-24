import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { sha } from '../src/remote/oauth.js';

const usage = `Uso: node scripts/remote-admin.js <comando>   (precisa de OLLYX_DATABASE_URL no ambiente)
  migrate                       aplica sql/*.sql (idempotente)
  user:create "Nome" [--admin]  cria usuário e mostra o código de acesso UMA vez
  user:rotate <id>              gera novo código de acesso para o usuário
  user:disable <id> | user:enable <id>
  user:list
  purge:ml                      apaga TODO o conteúdo do ML guardado (pedidos em cache, exportações, conexão); exigido ao ter o acesso revogado`;

export const newAccessCode = () => 'oxu_' + randomBytes(24).toString('base64url');

export async function run(argv, pool, out = console.log) {
  const [cmd, a, b] = argv;
  if (cmd === 'migrate') {
    const dir = fileURLToPath(new URL('../sql/', import.meta.url));
    for (const f of (await readdir(dir)).filter(n => n.endsWith('.sql')).sort()) { await pool.query(await readFile(dir + f, 'utf8')); out('aplicado: ' + f); }
  } else if (cmd === 'user:create' && a) {
    const code = newAccessCode(), papel = b === '--admin' ? 'admin' : 'user';
    const r = await pool.query('INSERT INTO mcp.users (nome, papel, code_hash) VALUES ($1, $2, $3) RETURNING id', [a, papel, sha(code)]);
    out(`Usuário criado (${papel}) id=${r.rows[0].id}\nCódigo de acesso (guarde agora, não será mostrado de novo): ${code}`);
  } else if (cmd === 'user:rotate' && a) {
    const code = newAccessCode();
    const r = await pool.query('UPDATE mcp.users SET code_hash = $2 WHERE id = $1 RETURNING nome', [a, sha(code)]);
    if (!r.rowCount) throw new Error('Usuário não encontrado.');
    await pool.query('UPDATE mcp.tokens SET revoked = true WHERE user_id = $1', [a]);
    out(`Novo código de ${r.rows[0].nome} (sessões antigas revogadas): ${code}`);
  } else if ((cmd === 'user:disable' || cmd === 'user:enable') && a) {
    const ativo = cmd === 'user:enable';
    const r = await pool.query('UPDATE mcp.users SET ativo = $2 WHERE id = $1', [a, ativo]);
    if (!r.rowCount) throw new Error('Usuário não encontrado.');
    if (!ativo) await pool.query('UPDATE mcp.tokens SET revoked = true WHERE user_id = $1', [a]);
    out(ativo ? 'Usuário reativado.' : 'Usuário desativado e sessões revogadas.');
  } else if (cmd === 'user:list') {
    for (const u of (await pool.query('SELECT id, nome, papel, ativo, created_at FROM mcp.users ORDER BY created_at')).rows) out(`${u.id}  ${u.papel.padEnd(5)}  ${u.ativo ? 'ativo  ' : 'inativo'}  ${u.nome}`);
  } else if (cmd === 'purge:ml') {
    // Cláusula 14 dos Termos do Programa de Desenvolvedores: ao revogar o acesso, destruir de forma irreversível as cópias do Conteúdo do ML.
    const copias = await pool.query("DELETE FROM mcp.kv WHERE key LIKE 'orders2-%' OR key LIKE 'export.%' RETURNING 1");
    const conexao = await pool.query("DELETE FROM mcp.provider_tokens WHERE provider = 'meli' RETURNING 1");
    out(`Conteúdo do ML apagado: ${copias.rowCount} cópia(s) de pedidos/exportações e ${conexao.rowCount} conexão(ões). Dados do Bling não foram tocados.`);
  } else out(usage);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.OLLYX_DATABASE_URL;
  if (!url) { console.error(usage); process.exit(1); }
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({ connectionString: url, max: 1, ssl: local ? false : { rejectUnauthorized: false } });
  run(process.argv.slice(2), pool).catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
}
