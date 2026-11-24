import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { ApiClient } from './client.js';
import { TokenManager } from './tokens.js';
import { loadConfig } from './config.js';
import { findResources } from './catalog.js';
import { createApiLogger, apiLogFile, readApiLogs } from './api-logger.js';
import { OllyxError, publicError } from './errors.js';
import { protectResult } from './privacy.js';

const HELP = `Ollyx — terminal de APIs (somente leitura)

  status                              Ver fontes de conexão, sem revelar credenciais
  recursos bling estoque              Buscar endpoints e parâmetros (primeiros 20)
  GET bling /produtos limite=1         Consultar uma página do Bling
  GET meli /users/me                  Consultar a conta do ML
  GET meli /orders/search seller=123 limit=5
  logs 20                             Ver as últimas linhas do log de hoje (UTC)
  ajuda                               Mostrar estes comandos
  sair                                Encerrar

Use chave=valor para filtros; repita a chave para listas.
No modo interativo, coloque valores com espaços entre aspas.
Cada GET retorna apenas uma página. O terminal não executa comandos do sistema.
Credenciais são lidas da configuração local; não digite tokens no terminal.`;

export function tokenize(line) {
  const words = [];
  let current = '', quote = null, started = false;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      started = true;
    } else if (char === '"' || char === "'") {
      quote = char; started = true;
    } else if (/\s/.test(char)) {
      if (started) { words.push(current); current = ''; started = false; }
    } else { current += char; started = true; }
  }
  if (quote) throw new OllyxError('invalid_command', 'Feche as aspas do comando.');
  if (started) words.push(current);
  return words;
}

function providerName(value) {
  const provider = value?.toLowerCase() === 'ml' ? 'meli' : value?.toLowerCase();
  if (!['bling', 'meli'].includes(provider)) throw new OllyxError('invalid_command', 'Use o provedor bling ou meli.');
  return provider;
}

export function parseQuery(words) {
  const [, name, path, ...filters] = words;
  const provider = providerName(name);
  if (words[0]?.toLowerCase() !== 'get' || !path) throw new OllyxError('invalid_command', 'Uso: GET bling /produtos limite=1');
  const params = Object.create(null);
  for (const filter of filters) {
    const separator = filter.indexOf('=');
    if (separator < 1) throw new OllyxError('invalid_command', 'Filtros devem usar chave=valor.');
    const key = filter.slice(0, separator), value = filter.slice(separator + 1);
    if (Object.hasOwn(params, key)) params[key] = [...(Array.isArray(params[key]) ? params[key] : [params[key]]), value];
    else params[key] = value;
  }
  return { provider, path, params };
}

export async function executeCommand(words, { api, tokens, config, logger, output }) {
  const command = words[0]?.toLowerCase();
  const show = value => output.write(JSON.stringify(value, null, 2) + '\n');
  if (!command) return true;
  if (['sair', 'exit', 'quit'].includes(command)) return false;
  if (['ajuda', 'help', '--help', '-h'].includes(command)) { output.write(HELP + '\n'); return true; }
  if (command === 'status') {
    show({ mode: 'read_only', providers: await Promise.all(['bling', 'meli'].map(async provider => ({
      provider, source: await tokens.source(provider),
    }))), apiLogging: config.apiLogging, log: apiLogFile(config.apiLogDir) });
  } else if (['recursos', 'resources'].includes(command)) {
    show(findResources(providerName(words[1]), words.slice(2).join(' '), 0, 20));
  } else if (command === 'logs') {
    await logger.flush();
    show({ file: apiLogFile(config.apiLogDir), entries: await readApiLogs(config.apiLogDir, Number(words[1] ?? 20)) });
  } else if (command === 'get') {
    const { provider, path, params } = parseQuery(words);
    show(protectResult(await api.query(provider, path, params), { provider, path }));
  } else {
    throw new OllyxError('invalid_command', 'Comando desconhecido. Use ajuda. Apenas GET é permitido para consultas.');
  }
  return true;
}

export async function main(argv = process.argv.slice(2), { input = process.stdin, output = process.stdout, error = process.stderr } = {}) {
  const config = loadConfig();
  const tokens = new TokenManager(config);
  const logger = createApiLogger({ directory: config.apiLogDir, enabled: config.apiLogging, write: line => error.write(line) });
  const api = new ApiClient(config, tokens, { logger });
  const context = { api, tokens, config, logger, output };
  try {
    if (argv.length) {
      await executeCommand(argv, context);
      return 0;
    }
    output.write(HELP + '\n\n');
    const terminal = Boolean(input.isTTY && output.isTTY);
    const readline = createInterface({ input, output, terminal, historySize: 0, crlfDelay: Infinity });
    readline.setPrompt('ollyx> ');
    if (terminal) readline.prompt();
    try {
      for await (const line of readline) {
        try { if (!await executeCommand(tokenize(line), context)) break; }
        catch (failure) { error.write(JSON.stringify({ error: publicError(failure) }) + '\n'); }
        if (terminal) readline.prompt();
      }
    } finally { readline.close(); }
    return 0;
  } catch (failure) {
    error.write(JSON.stringify({ error: publicError(failure) }) + '\n');
    return 1;
  } finally { await logger.flush(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(failure => {
    process.stderr.write(JSON.stringify({ error: publicError(failure) }) + '\n');
    process.exitCode = 1;
  });
}
