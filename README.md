# Ollyx MCP 0.3

MCP local de leitura para Bling v3 e Mercado Livre, compatível com clientes MCP por stdio. A versão 0.2 inclui extensão .mcpb para Claude Desktop e configuração portátil para outros computadores.

## Claude Desktop

Use ollyx-mcp.mcpb e siga CLAUDE-DESKTOP.md. Cada PC configura sua própria conexão. Código e bibliotecas acompanham a extensão; credenciais não.

A extensão aceita um arquivo de conexão externo, que permanece separado da instalação. Também há campos protegidos para tokens temporários. As instruções incluem autorização OAuth para uso contínuo e instalação por configuração JSON.

## Instalar a partir dos fontes

Requer Node.js 22+ e npm. Extraia o ZIP e execute na pasta do projeto:

~~~text
npm ci --ignore-scripts
npm run setup
~~~

No Windows, scripts/setup.ps1 combina essas duas etapas. O setup preserva o .env existente e gera configurações para Claude Desktop, Codex e outros clientes. Os caminhos gerados pertencem ao PC onde o comando foi executado.

Edite o .env apenas localmente. Não publique nem envie ao chat tokens, client secrets ou URLs de callback com código.

Para usar outro arquivo de conexão, defina OLLYX_CONFIG_FILE com o caminho completo antes de iniciar o servidor ou o assistente OAuth. Os caminhos relativos de tokens e integrações passam a ser resolvidos a partir da pasta desse arquivo.

## Conexões

Escolha um modo por provedor. Ordem de prioridade:

1. BLING_ACCESS_TOKEN ou MELI_ACCESS_TOKEN: temporário, sem renovação automática.
2. BLING_SHARED_ENV_FILE ou MELI_SHARED_ENV_FILE: arquivo de outra integração local; o MCP lê o cache e não renova nem altera tokens compartilhados.
3. BLING_USE_OLLYX_DATABASE ou MELI_USE_OLLYX_DATABASE com OLLYX_DATABASE_URL: SELECT em oauth_tokens, sem alterar o banco ou renovar os tokens.
4. Arquivo OAuth próprio em BLING_TOKEN_FILE ou MELI_TOKEN_FILE: renovação automática pelo MCP.

Para OAuth próprio, preencha CLIENT_ID, CLIENT_SECRET e REDIRECT_URI do provedor e execute:

~~~text
npm run auth -- bling
npm run auth -- meli
~~~

O assistente verifica state, usa PKCE/S256 no Meli e salva os tokens localmente. O único POST interno troca ou renova credenciais OAuth; as ferramentas de negócio expõem somente GET.

No Bling, os módulos acessíveis dependem dos escopos configurados no aplicativo e das permissões do usuário que autoriza. No Meli, o assistente solicita read e offline_access. Não altere escopos de um app compartilhado sem considerar as autorizações existentes.

O modo compartilhado reconhece BLING_TOKEN_CACHE_FILE e TOKEN_CACHE_FILE no arquivo de origem. O modo banco atende ao esquema da Ollyx com provider=bling ou provider=mercado_livre e as colunas access_token/expires_at.

Os arquivos OAuth não têm criptografia de aplicação. O acesso depende das permissões locais da pasta. Não distribua os arquivos preenchidos com o pacote.

## Ferramentas e cobertura

| Ferramenta | Função |
|---|---|
| ollyx_status | Configuração e cobertura local, sem revelar credenciais. Com `verificar=true`, testa os escopos reais com consultas GET leves. |
| ollyx_recursos | Busca rotas e parâmetros por provedor e termo. |
| ollyx_consultar | Uma consulta GET por caminho relativo e filtros. |
| ollyx_consultar_paginas | Uma sequência limitada de páginas com indicação de continuação. |
| ollyx_curva_abc | Curva ABC de vendas do Mercado Livre calculada no servidor (cache por dia, CSV de exportação, progresso). |
| ollyx_depara_sku | De-para de SKU do catálogo Bling: kits, variações, custo e alertas (cache de 6h). |

Cache e CSV ficam na pasta de dados (`OLLYX_DATA_DIR`; padrão `.ollyx` na pasta do usuário), fora do pacote. `OLLYX_DEBUG=1` envia detalhes de erro ao stderr, nunca ao chat.

O recurso ollyx://overview contém orientações gerais.

Bling: 100 endpoints GET extraídos do OpenAPI oficial de 05/11/2026. Meli: consultas genéricas GET no host oficial e guia inicial de 43 rotas. O guia Meli não é exaustivo. Mercado Pago não integra esta versão.

Inclui consultas de produtos, estoque, pedidos, contatos, logística, notas, perguntas, mensagens, mediações e outros módulos autorizados. Relatórios que exigem POST para geração não são criados pelo MCP. Dados exclusivos das telas e do banco de atendimento da Ollyx não são expostos.

## Exemplos

Argumentos de ollyx_consultar para pedidos Bling:

~~~json
{
  "provider": "bling",
  "path": "/pedidos/vendas",
  "params": { "pagina": 1, "limite": 50, "dataInicial": "2026-11-01", "dataFinal": "2026-11-05" }
}
~~~

Conta Meli:

~~~json
{ "provider": "meli", "path": "/users/me" }
~~~

Use o id retornado em seller para /orders/search. Substitua as variáveis dos caminhos por IDs reais.

Mensagens:

~~~json
{
  "provider": "meli",
  "path": "/messages/packs/123/sellers/456",
  "params": { "tag": "post_sale" }
}
~~~

O cliente força mark_as_read=false e bloqueia a marcação de mensagens como lidas.

## Limites e respostas

A consulta simples retorna uma página. A consulta de páginas suporta pagina/limite documentados no Bling e offset/limit com results[] e paging compatíveis no Meli. O padrão é 5 páginas, no máximo 20.

complete=false exige continuar com nextParams ou ajustar o recurso. Cursor/scan e formatos diferentes usam a consulta simples manualmente. complete=true significa fim da sequência a partir da página inicial, sem garantia de snapshot transacional.

O processo espaça chamadas em pelo menos 400 ms no Bling e 250 ms no Meli. As cotas das APIs também são compartilhadas com outras integrações. Há retentativas limitadas, respeito a Retry-After e indicação explícita de erro parcial.

OLLYX_TIMEOUT_MS: padrão de 20 segundos por requisição. OLLYX_MAX_RESPONSE_BYTES: padrão de 2 MiB. Respostas acima do limite geram erro explícito. Documentos pequenos voltam como texto ou base64. URLs externas e redirects não são seguidos.

Cabeçalhos opcionais de versão: api-version (1 ou 2), x-new-domain=true e x-format-new=true. Não há cabeçalhos livres nem troca de método pelo modelo.

## Outros clientes

npm run config:generate cria config/mcp.json, config/claude_desktop_config.json e config/codex.toml com caminhos locais. Incorpore somente a entrada Ollyx à configuração do cliente, preservando o restante. Após mover a pasta, gere os arquivos novamente.

O cliente inicia o processo local. npm start, executado manualmente, fica esperando mensagens MCP pelo stdin.

## Testar e empacotar

Para testar endpoints em um terminal, use `npm run api`. O terminal permite buscar
rotas, executar GET e consultar os logs com `logs 20`. Também há execução direta:
`npm run api -- GET bling /produtos limite=1`.
Veja [Terminal de APIs e logs](docs/TERMINAL.md) para os comandos e a configuração.

~~~text
npm test
python scripts/package.py
~~~

O empacotador gera ZIP de fontes e MCPB com bibliotecas instaladas. Exclui .env, secrets, configurações geradas, logs e relatórios da máquina original. Execute npm ci antes de gerar o MCPB.

Foram verificados o protocolo MCP por stdio, os bloqueios de escrita, mensagens não lidas, OAuth, paginação, configurações externas e caminhos de instalação. A versão foi executada em Windows. A compatibilidade de caminhos Unix/macOS tem testes de configuração; o aplicativo em macOS não foi executado nesta entrega.

## Referências

- [Bling API](https://developer.bling.com.br/referencia)
- [Bling: aplicativos e escopos](https://developer.bling.com.br/aplicativos)
- [Meli: autorização](https://developers.mercadolivre.com.br/autenticacao-e-autorizacao)
- [Meli: mensagens](https://developers.mercadolivre.com.br/mensagens-post-venda)
- [MCP SDK](https://ts.sdk.modelcontextprotocol.io/server)
- [Claude Desktop](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)

## Modo em rede (Vercel)

O mesmo MCP pode rodar em HTTPS, sem `.env` em cada computador: ver [docs/REMOTE.md](docs/REMOTE.md) (implantação) e [docs/OPERACAO.md](docs/OPERACAO.md) (operação, problemas conhecidos e pendências) e [docs/CONFORMIDADE-ML.md](docs/CONFORMIDADE-ML.md) (Termos do Mercado Livre).
