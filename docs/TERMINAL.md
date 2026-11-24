# Terminal de APIs e logs

Requer Node.js 22 ou mais recente e a conexão local configurada conforme o README.
Na pasta do projeto, execute `npm run api` (`npm.cmd run api` no PowerShell).

```text
status
recursos bling estoque
GET bling /produtos limite=1 pagina=1
GET bling /pedidos/vendas dataInicial=2026-11-01 dataFinal=2026-11-05 limite=5
GET meli /users/me
GET meli /orders/search seller=SEU_ID limit=5
logs 20
sair
```

Também funciona sem sessão interativa:

```text
npm run api -- GET bling /produtos limite=1
npm run api -- recursos meli pedidos
npm run api:logs -- 50
```

Os comandos GET usam o mesmo cliente do MCP: hosts fixos, limites, retentativas,
mensagens sem marcar como lidas e bloqueio de endpoints de autenticação.
Cada resposta representa uma página. Dados pessoais e credenciais são ocultados
na saída. Para filtros com espaços, use aspas no modo interativo:
`GET bling /produtos nome="Colar dourado" limite=5`.
Não há execução de comandos do sistema nem operações POST, PUT, PATCH ou DELETE.
O histórico da sessão não é persistido.

## Logs das APIs

Cada tentativa HTTP registra uma linha JSON com horário UTC, provedor, método,
modelo do endpoint, status HTTP, duração em milissegundos, tentativa e identificador
de correlação. Uma falha definitiva também gera `api_error` com o código do erro.
A duração inclui a espera do limitador de chamadas. Tentativas de renovação OAuth
não têm seus corpos nem credenciais registrados.

O registro não inclui tokens, headers, filtros, respostas, dados de clientes ou IDs
dos pedidos. Os IDs dos caminhos são substituídos por parâmetros, como
`/orders/{order_id}`. Rotas Meli fora do catálogo aparecem como `/unlisted`.

No terminal e no MCP local, o arquivo fica em:

```text
%USERPROFILE%\.ollyx\logs\api-AAAA-MM-DD.jsonl
```

`OLLYX_DATA_DIR` muda a pasta base. Os arquivos são separados por dia UTC e não são
apagados automaticamente. `OLLYX_API_LOG=0` desliga os logs de consultas, incluindo
o arquivo e o stderr. Logs gerais de operação continuam disponíveis.
`logs` lê apenas o final do arquivo de hoje (até 200 registros por comando).

Os mesmos eventos são enviados ao stderr. No MCP, stdout fica reservado ao protocolo.
Na Vercel, os eventos vão para os logs da plataforma, sem arquivo local persistente.
Depois de publicar a versão, consulte-os com:

```text
npx.cmd vercel logs --deployment ollyx-mcp.vercel.app --since 30m --json
```

Falhas ao gravar o arquivo são avisadas no stderr e não interrompem uma consulta.
Logs e configurações privadas ficam fora do Git e dos pacotes de distribuição.
