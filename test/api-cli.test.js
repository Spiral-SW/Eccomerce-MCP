import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCommand, parseQuery, tokenize } from '../src/api-cli.js';
import { loadConfig } from '../src/config.js';

test('terminal preserva espaços, igualdade e filtros repetidos sem executar o texto', () => {
  const query = parseQuery(tokenize('GET bling /produtos nome="Colar dourado" ids[]=1 ids[]=2 codigo=x=y'));
  assert.equal(query.provider, 'bling');
  assert.deepEqual({ ...query.params }, { nome: 'Colar dourado', 'ids[]': ['1', '2'], codigo: 'x=y' });
  assert.equal(parseQuery(['GET', 'ML', '/users/me']).provider, 'meli');
  assert.throws(() => tokenize('GET bling "unterminated'), /Feche as aspas/);
  assert.throws(() => parseQuery(['GET', 'bling', '/produtos', 'limite']), /chave=valor/);
  assert.throws(() => parseQuery(['GET', 'outro', '/produtos']), /bling ou meli/);
});

test('terminal protege dados da resposta, recusa escrita e mantém a sessão após comando inválido', async () => {
  const lines = [], calls = [];
  const context = {
    config: loadConfig({}, false), tokens: { source: async () => 'not_configured' },
    logger: { flush: async () => {} }, output: { write: value => lines.push(value) },
    api: { query: async (...args) => { calls.push(args); return { data: { id: 1, buyer: { email: 'private@example.test' } } }; } },
  };
  assert.equal(await executeCommand(['GET', 'meli', '/orders/1', 'limit=5'], context), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].limit, '5');
  assert.equal(lines.join('').includes('private@example.test'), false);
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE', 'powershell']) await assert.rejects(executeCommand([verb, 'meli', '/orders/1'], context), /Apenas GET/);
  assert.equal(calls.length, 1);
  await executeCommand(['status'], context);
  assert.equal(JSON.parse(lines.at(-1)).mode, 'read_only');
  assert.equal(await executeCommand(['sair'], context), false);
});
