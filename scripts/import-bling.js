import { readFile, writeFile, mkdir } from 'node:fs/promises';
const specFile = process.argv[2];
if (!specFile) throw new Error('Uso: npm run catalog:bling -- caminho/openapi.json [URL de origem]');
const spec = JSON.parse(await readFile(specFile, 'utf8'));
const resolveRef = object => object?.$ref ? object.$ref.split('/').slice(1).reduce((o, k) => o[k], spec) : object;
const resources = Object.entries(spec.paths).filter(([, v]) => v.get).map(([path, value]) => ({
  path, method: 'GET', summary: value.get.summary || path, groups: value.get.tags || [],
  parameters: [...(value.parameters || []), ...(value.get.parameters || [])].map(resolveRef).map(p => ({
    name: p.name, in: p.in, required: p.required || false, description: p.description || '', schema: resolveRef(p.schema) || {},
  })),
}));
if (!resources.length || spec.info?.title !== 'Bling API') throw new Error('O arquivo não é um OpenAPI válido do Bling.');
const output = {
  source: process.argv[3] || 'https://developer.bling.com.br/referencia', importedAt: new Date().toISOString(),
  coverage: 'Todos os endpoints GET desta versão do OpenAPI oficial. Permissões dependem da conta e aplicativo.',
  resources,
};
await mkdir(new URL('../catalog/', import.meta.url), { recursive: true });
await writeFile(new URL('../catalog/bling.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
console.log('Catálogo atualizado: ' + resources.length + ' endpoints GET do Bling.');
