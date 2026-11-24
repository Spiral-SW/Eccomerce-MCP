# MCP Ollyx em rede (Vercel + Supabase)

O mesmo MCP, servido por HTTPS. Ninguém precisa de `.env`: as credenciais ficam no servidor, os usuários entram com um
código de acesso e o Claude conecta pela URL `https://SEU-DOMINIO/mcp`.

```
Claude (web/Desktop) --OAuth 2.1 + PKCE--> /authorize, /token, /register   (OAuth próprio do MCP)
Claude --Bearer--> /mcp (Streamable HTTP, sem estado) --> Bling / Mercado Livre (somente GET)
                        |
                        +--> Postgres (schema mcp): usuários, sessões, tokens dos provedores (cifrados), cache
```

## O que cada peça faz

| Peça | Onde |
|---|---|
| Entrada Vercel (rotas reescritas para uma função) | `api/index.js`, `vercel.json` |
| Rotas, `/mcp`, download assinado, conexão dos provedores | `src/remote/app.js` |
| Servidor OAuth (registro dinâmico, PKCE S256, refresh com rotação e detecção de reuso) | `src/remote/oauth.js` |
| Tokens Bling/ML cifrados (AES-256-GCM) e renovação com trava no banco | `src/remote/provider-tokens.js` |
| Esquema SQL (schema `mcp`, RLS ligado) | `sql/001_mcp_remote.sql` |
| Administração de usuários | `scripts/remote-admin.js` |

## Implantação (uma vez)

1. **Banco.** No Supabase, copie a *connection string* do pooler (modo transação). Ela será `OLLYX_DATABASE_URL`.
2. **Chave de cifragem dos tokens.** Gere e guarde (se perder, é preciso reconectar Bling e ML):
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` → `OLLYX_TOKEN_KEY`.
3. **Migração.** Com `OLLYX_DATABASE_URL` no ambiente: `npm run remote:migrate`.
4. **Administrador.** `npm run remote:admin -- user:create "Seu Nome" --admin`. O código `oxu_…` aparece **uma vez**.
   Outros usuários: `user:create "Nome"`. Também existem `user:list`, `user:rotate <id>`, `user:disable <id>`, `user:enable <id>`.
5. **Vercel.** Importe esta pasta como projeto (framework: Other) e defina as variáveis:

   | Variável | Valor |
   |---|---|
   | `OLLYX_DATABASE_URL` | connection string do passo 1 |
   | `OLLYX_PUBLIC_URL` | `https://SEU-DOMINIO` (sem barra final) |
   | `OLLYX_TOKEN_KEY` | chave do passo 2 |
   | `BLING_CLIENT_ID`, `BLING_CLIENT_SECRET` | app do Bling |
   | `MELI_CLIENT_ID`, `MELI_CLIENT_SECRET` | app do Mercado Livre |
   | `OLLYX_REDIRECT_HOSTS` | opcional; padrão `claude.ai, claude.com, chatgpt.com e openai.com` (destinos permitidos no login) |
   | `OLLYX_DEBUG` | opcional; `1` manda detalhes de erro aos logs |

6. **Redirecionamentos nos apps dos provedores.** Cadastre `https://SEU-DOMINIO/admin/callback/bling` no app do Bling e
   `https://SEU-DOMINIO/admin/callback/meli` no do Mercado Livre.
7. **Conectar os provedores (uma vez).** Abra `https://SEU-DOMINIO/admin/connect/bling` e `/admin/connect/meli`,
   informe o código de administrador e autorize.
8. **Claude.** Adicione um conector personalizado com a URL `https://SEU-DOMINIO/mcp` e faça login com o seu código.

## Tarefa diária (Vercel Cron)

`vercel.json` agenda `GET /api/cron/daily` todo dia às 07:00 UTC (04:00 em Brasília). A rota só existe se `CRON_SECRET`
estiver definida na Vercel (a Vercel envia `Authorization: Bearer <CRON_SECRET>`); sem o segredo correto responde 401.
Ela faz, em etapas independentes (uma falha não impede as outras):

1. **banco:** uma consulta, para o plano gratuito do Supabase não pausar o projeto por inatividade;
2. **tokens:** renova Bling e Mercado Livre, mantendo viva a cadeia de refresh (que expira se ficar semanas sem uso);
3. **catálogo:** atualiza o catálogo do Bling e as estruturas de kits;
4. **pedidos:** aquece 35 dias de pedidos pagos, para a primeira curva ABC do dia responder em ~1 s.

Status 200 = tudo certo; 207 = alguma etapa falhou (o corpo diz qual). O log traz uma linha `tarefa diária`.

## Desempenho e registros

- Cada chamada de ferramenta gera uma linha no log: `ferramenta=… 123ms externas=N(…ms) erro=…`. Cada acesso HTTP gera
  `método caminho status tempo rpc=… ua=…` (sem query, sem tokens, sem argumentos).
- `ollyx_consultar` e `ollyx_consultar_paginas` aceitam `campos` (ex.: `["id","codigo","estoque.saldoVirtualTotal"]`) para
  devolver só o necessário; respostas completas do Bling trazem descrições HTML enormes.
- O ritmo entre chamadas às APIs (250 ms no Mercado Livre, 400 ms no Bling) é o limite da leitura a frio; o cache e a
  tarefa diária evitam pagá-lo no uso normal.

## Segurança

- Clientes públicos com PKCE S256 obrigatório; códigos de autorização de uso único (consumo atômico no banco).
- Refresh com rotação; reaproveitar um refresh antigo revoga toda a sessão (access tokens incluídos).
- Códigos de acesso e tokens ficam só como hash SHA-256; tokens dos provedores, cifrados com `OLLYX_TOKEN_KEY`.
- O registro de clientes é aberto (exigência do protocolo), mas só aceita destinos https de `OLLYX_REDIRECT_HOSTS`
  (e loopback). A tela de login mostra para onde o usuário será levado.
- Limite de tentativas por IP em login, token, registro e conexão de provedores.
- Tabelas no schema `mcp`, que a API REST do Supabase não expõe; RLS ligado sem policies.
- Links de download de CSV são assinados (HMAC) e expiram em 1 hora.

## Atenção: rotação do token do Bling

Bling e Mercado Livre rotacionam o refresh token a cada renovação. O MCP em rede precisa da **sua própria autorização**
(passo 7). Não reutilize os tokens de outra conexão (por exemplo a do Ollyx-OS ou a do MCP local): duas renovações
independentes do mesmo token se invalidam. Reautorizar o app pode invalidar a conexão antiga; teste fora do horário de pico.

## Verificação

- `npm test` roda tudo com bancos simulados, inclusive o fluxo OAuth e um cliente MCP real pela rede.
- `npm i --no-save @electric-sql/pglite && node scripts/verify-postgres.mjs` executa o SQL, o OAuth, o cache e a
  renovação de tokens contra um Postgres real em memória.
- Ainda **não verificado** em produção: reescrita de rotas e `includeFiles` na Vercel, SSL do pooler do Supabase e
  o fluxo de conector do claude.ai.
