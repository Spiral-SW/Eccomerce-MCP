# Operação do MCP Ollyx em rede

Guia para quem opera o serviço depois da implantação. Complementa [REMOTE.md](REMOTE.md) (arquitetura e implantação).
O serviço roda sozinho na Vercel e no Supabase: **não depende de nenhuma sessão de chat nem desta máquina**.

## Onde está cada coisa

| Peça | Onde |
|---|---|
| Serviço (MCP e OAuth) | Vercel, projeto `spiral-sw/ollyx-mcp` (plano Hobby) — https://ollyx-mcp.vercel.app |
| Endereço do conector no Claude | `https://ollyx-mcp.vercel.app/mcp` |
| Banco | Supabase, projeto **Ollyx-OS** (ref `nnssrkzfgxvgfwwfrekc`), schema `mcp` (7 tabelas) |
| Usuário de banco do MCP | `mcp_app` (só o schema `mcp`; ver `sql/002_mcp_app_role.sql`) |
| Código-fonte | [Spiral-SW/Eccomerce-MCP](https://github.com/Spiral-SW/Eccomerce-MCP) |
| Segredos locais | `%USERPROFILE%\.ollyx\remote-secrets.txt`: `OLLYX_TOKEN_KEY`, `OLLYX_ADMIN_CODE`, `CRON_SECRET` |

**Nunca perca `OLLYX_TOKEN_KEY`**: sem ela os tokens do Bling e do Mercado Livre guardados no banco não podem ser
decifrados e é preciso reconectar os dois. Nunca a digite em nenhuma tela. O código de login é o `OLLYX_ADMIN_CODE` (`oxu_…`).

Variáveis na Vercel (Settings → Environment Variables, só os nomes): `OLLYX_DATABASE_URL`, `OLLYX_PUBLIC_URL`,
`OLLYX_TOKEN_KEY`, `CRON_SECRET`, `BLING_CLIENT_ID`, `BLING_CLIENT_SECRET`, `ML_CLIENT_ID`, `ML_CLIENT_SECRET`
(`MELI_*` também vale), `OLLYX_TIMEOUT_MS`, `OLLYX_MAX_RESPONSE_BYTES`. Opcionais: `OLLYX_REDIRECT_HOSTS`, `OLLYX_DEBUG=1`.

## Rotinas

| Para… | Faça |
|---|---|
| Verificar se está tudo bem | `node scripts/smoke-prod.mjs` (17 verificações: login, ferramentas, Bling, ML, de-para, curva ABC, download) |
| Ver o que aconteceu | `npx.cmd vercel logs --deployment ollyx-mcp.vercel.app --since 30m --json` (cada ferramenta e cada acesso deixam uma linha) |
| Testar um endpoint localmente | `npm run api` ([comandos e logs](TERMINAL.md)) |
| Publicar uma mudança | na pasta: `npm test` e depois `npx.cmd vercel deploy --prod --yes`. Use `npx.cmd`: o PowerShell bloqueia o `npx.ps1`. O `vercel link` cria um `.env.local` com token: apague-o. |
| Mudar uma variável | pelo **painel web da Vercel** (colar no terminal falhou várias vezes), depois publique de novo |
| Criar ou desativar usuário | `npm run remote:admin -- user:create "Nome"` / `user:disable <id>` / `user:rotate <id>` (com `OLLYX_DATABASE_URL` no ambiente) |
| Reconectar Bling ou Mercado Livre | abra `/admin/connect/bling` ou `/admin/connect/meli`, informe o código de administrador e autorize |
| Liberar um IP bloqueado | no SQL Editor: `delete from mcp.hits where bucket in ('authorize','admin');` |
| Rodar a tarefa diária na mão | `GET /api/cron/daily` com `Authorization: Bearer <CRON_SECRET>` |

Links de redirecionamento nos apps dos provedores: `https://ollyx-mcp.vercel.app/admin/callback/bling` e
`https://ollyx-mcp.vercel.app/admin/callback/meli`. O Bling aceita **um** link por aplicativo e recusa antes do login;
o Mercado Livre só compara depois do login.

## Incidentes de segurança e privacidade (Termos do ML, cláusulas 2.2.2, 6.3 e 10)

Canal de notificação ao Mercado Livre: o suporte do Programa de Desenvolvedores (https://developers.mercadolivre.com.br/devcenter/support).

| Situação | Prazo | O que fazer |
|---|---|---|
| Vulnerabilidade que afete o aplicativo, os sistemas ou dados de usuários do ML | **em até 24 h** após saber | 1) conter (desativar usuário, revogar sessões); 2) notificar o ML pelo canal acima; 3) corrigir no prazo que o ML indicar |
| Uso não autorizado de chave ou token do ML | imediatamente | trocar o `Client Secret` no painel do ML, reconectar em `/admin/connect/meli`, notificar o ML |
| Incidente de privacidade (perda, acesso ou alteração indevida de dados pessoais) ou pedido de autoridade sobre esses dados | imediatamente e sem demora injustificada | notificar o ML e o controlador, preservar os registros, colaborar na investigação |
| Acesso revogado ou programa encerrado | ao ser revogado | `npm run remote:admin -- purge:ml`; apagar `cache/` e `exports/` locais; parar de usar a API |

Registros para investigação: `vercel logs` (cada ferramenta e cada acesso, sem tokens nem argumentos) e a tabela `mcp.users`.
Defina **uma pessoa responsável** por receber os avisos do ML (cláusula 9: o ML pode auditar sem aviso prévio).

Dados pessoais de usuários do ML **nunca saem do servidor**: `src/privacy.js` oculta nome, apelido, e-mail, telefone,
documento, endereço, pagamento e conversas nas consultas genéricas. Não há chave para desligar; para mudar a regra, é
preciso decisão registrada. Detalhes em [CONFORMIDADE-ML.md](CONFORMIDADE-ML.md).

## Tarefa diária (04:00 em Brasília)

Toca o banco (o Supabase gratuito pausa projetos parados), renova os tokens (a cadeia de refresh expira se ninguém
usar por semanas), atualiza o catálogo do Bling, **relê** 35 dias de pedidos (as cópias valem 24 h, cláusula 5.3 dos Termos do ML)
e apaga qualquer cópia de pedidos ou exportação com mais de 25 h (cláusula 2.2.1.3). 200 = tudo certo; 207 = alguma etapa falhou.

## Problemas já vistos: sintoma → causa → solução

| Sintoma | Causa | Solução |
|---|---|---|
| 503 `service_unconfigured` | falta variável de ambiente | conferir as variáveis acima e os logs do deploy |
| Log `ENOTFOUND base` | `OLLYX_DATABASE_URL` guardada só com a senha ou mal colada | salvar a string **completa**: `postgresql://usuario:senha@aws-1-us-west-2.pooler.supabase.com:6543/postgres`. Com o `mcp_app`, o usuário é `mcp_app.nnssrkzfgxvgfwwfrekc` |
| Claude: "A autorização com Ollyx falhou" | corrigido (a tela não reenviava `response_type`); se voltar, olhar `POST /authorize` e `POST /token` nos logs | remover o conector, adicionar de novo e clicar em conectar **uma só vez** |
| "Muitas tentativas" no login | 10 códigos errados em 10 minutos no mesmo IP | esperar ou liberar com o SQL acima. Usar o `OLLYX_ADMIN_CODE`, e não a chave de cifragem |
| Bling `redirect_uri_mismatch` | link do aplicativo diferente do callback | deixar exatamente `https://ollyx-mcp.vercel.app/admin/callback/bling`, sem barra no fim; leva um instante para valer |
| `reconnect_required` | refresh token expirou ou o aplicativo foi reautorizado em outro sistema | reconectar em `/admin/connect/*`. Não autorize o mesmo aplicativo de dois sistemas: um invalida o outro |
| ChatGPT: `POST /register 400` nos logs | endereço de retorno do cliente fora da lista permitida | a lista padrão inclui `claude.ai`, `claude.com`, `chatgpt.com` e `openai.com`; outros clientes exigem `OLLYX_REDIRECT_HOSTS` |
| ChatGPT: "Authentication succeeded, action discovery failed" | o ChatGPT recusa a lista de ferramentas se algum esquema não for JSON Schema moderno (ex.: `z.tuple` vira `items: [...]`) | usar `z.array(...).length(n)`; o teste `esquemas das ferramentas são JSON Schema moderno` protege isso. Depois recriar o plugin no ChatGPT |
| ChatGPT: plugin conectado, mas "sem funções" no chat | chat aberto antes da conexão | abrir uma **conversa nova** com o Ollyx selecionado (nos logs: `initialize` e `tools/list` de `openai-mcp`) |
| Supabase `INACTIVE` | projeto gratuito pausado por inatividade | restaurar no painel; a tarefa diária evita |
| Claude lento, muitas chamadas | usando a consulta genérica página por página | as instruções já mandam usar `ollyx_curva_abc` e `ollyx_depara_sku`; usar `campos` nas consultas |
| Primeira curva ABC demora ~32 s | leitura a frio: ~125 chamadas ao ML com 250 ms entre cada | normal; a tarefa diária e o cache evitam no dia a dia |
| Erro de cache com `INSERT`/`DELETE` negado | usuário de banco sem permissão no schema `mcp` | reaplicar `sql/002_mcp_app_role.sql` |

## Pendências e decisões em aberto (9/11/2026)

- **Senha do banco:** a do `postgres` apareceu em conversa e imagens. O MCP deve usar o `mcp_app` em `OLLYX_DATABASE_URL`;
  depois disso, trocar a senha do `postgres` (Project Settings → Database → Reset database password) não afeta o MCP.
- **Plano da Vercel:** o Hobby é para uso pessoal e não comercial; para produção da Ollyx, migrar para Pro.
- **Git:** a pasta não é um repositório. Criar um privado.
- **Somente leitura:** é uma regra de segurança. Escrever nas contas (estoque, perguntas, contas a pagar) exigiria permissão
  por usuário, confirmação antes de agir e auditoria, caso a caso.
- Pacote `.mcpb` local (`outputs/ollyx-mcp.mcpb`) é do modo local e não foi regerado desde as últimas mudanças.
