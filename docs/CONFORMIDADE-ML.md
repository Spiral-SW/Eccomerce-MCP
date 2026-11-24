# Conformidade com os Termos e Condições do Programa de Desenvolvedores do Mercado Livre (MLB)

**Fonte única:** o texto dos Termos e Condições do Programa de Desenvolvedores do Mercado Livre MLB, na versão com
"Copyright © 2026", fornecido pela Ollyx em 10/11/2026. Nenhuma outra regra foi usada. As cláusulas abaixo são
**parafraseadas** (leia o texto original para o conteúdo exato). Este documento é uma revisão técnica, **não é parecer
jurídico**: os pontos marcados como "decisão" dependem de interpretação do contrato ou de autorização do Mercado Livre.

Legenda: ✔ atendido pelo MCP · ⚠ decisão ou ação da Ollyx · ➖ não se aplica ao uso atual.

## Cláusula por cláusula

| Cláusula | O que exige (resumo) | Situação | Como o MCP atende / o que falta |
|---|---|---|---|
| 2 (a–f) | Usos proibidos; em especial divulgar a terceiros que não são usuários do ML informações obtidas pela integração | ⚠ | Dados pessoais não saem do servidor (ver 6 e 10). O resto do conteúdo vai ao assistente de IA que você usa (Claude, ChatGPT), um terceiro. **Decisão:** confirmar com o ML (canal do 16.4) que isso é permitido. |
| 2.2.1.3 | Só cópias intermediárias necessárias, apagadas de forma irreversível quando não forem mais úteis | ✔ | O cache de pedidos guarda só totais por SKU/anúncio, vale 24 h e o banco o apaga em 25 h (`CACHE_TTL_MS`); a tarefa diária ainda apaga qualquer cópia com mais de 25 h, mesmo gravada sem validade (`purgeStale`). Exportações CSV expiram em 24 h. Teste: `cache de pedidos (cláusulas 2.2.1.3 e 5.3)`. |
| 2.2.1.4 | Medidas de segurança para impedir acesso de terceiros não autorizados ao conteúdo | ✔ | OAuth 2.1 com PKCE, bearer por usuário, HTTPS com HSTS, banco com segurança por linha, tokens cifrados (AES-256-GCM), limite de tentativas de login. |
| 2.2.2 | Chaves e tokens em estrita confidencialidade; revelar a terceiros pode revogar o acesso; notificar imediatamente uso não autorizado | ✔ / ⚠ | Tokens cifrados no banco, nunca exibidos nem escritos em log; `Client Secret` na Vercel como variável sensível; tokens que estavam em variáveis foram removidos. **Ação:** seguir o procedimento de incidente em [OPERACAO.md](OPERACAO.md) e trocar a senha do banco que foi exposta (item abaixo). |
| 2.2.3, 7.5, 7.8 | Respeitar limites de chamadas; não contornar limites; não abusar do volume | ✔ | Intervalo mínimo de 250 ms entre chamadas ao ML, repetição com espera e respeito ao `Retry-After`; leitura a frio de 30 dias ≈ 125 chamadas, e a tarefa diária usa o mesmo ritmo. O limite é por processo (hoje há um só usuário). |
| 2.2.4 | Não usar "mercado", "livre", "pagamento", "envios" ou "crédito" (nem logotipos ou design parecidos) no título, conteúdo ou design do aplicativo | ✔ / ⚠ | O nome de exibição virou "Ollyx — Integração de vendas"; as descrições, instruções e mensagens do MCP usam "ML"; os resumos de rotas do catálogo foram reescritos. **Ação:** conferir o **nome do aplicativo cadastrado no painel de desenvolvedor do ML** e o nome do conector nos assistentes. |
| 3, 9 (quarentena) | O ML pode exigir certificação e pode pôr o desenvolvedor em quarentena | ⚠ | Sem ação técnica. Acompanhar os avisos do ML. |
| 5.2 | Exibir o conteúdo só no aplicativo; informações não públicas de usuários só com autorização do usuário; não misturar com conteúdo de terceiros | ✔ / ⚠ | Campos não públicos de pessoas são ocultados (ver 6). A margem combina vendas do ML com o custo do Bling, que é dado da própria Ollyx; **decisão:** confirmar que isso não conta como "misturar". |
| 5.3 | Atualizar o conteúdo ao menos a cada 24 h (6 h para listagens) e informar a frequência | ✔ | Cópias de pedidos com mais de 24 h são descartadas; a tarefa diária relê tudo; cada curva informa `frequenciaAtualizacao` e `dadosAtualizadosEm`. O MCP não guarda listagens de anúncios (consultas genéricas são em tempo real). |
| 5.4 | Autorização expressa do ML para usar ou publicar estatísticas do Site, vendas, médias de categoria, taxas de conversão ou informações sobre usuários específicos | ⚠ | A curva ABC usa só as vendas **da própria conta**. **Decisão:** pedir confirmação por escrito ao ML. Uma ferramenta de **concorrentes** ou de **mercado por categoria** é o caso típico de 5.4 e **não deve ser construída sobre a API do ML sem essa autorização**. |
| 6 | Dados pessoais: o desenvolvedor trata só conforme as instruções do controlador, com medidas de segurança; notifica o ML imediatamente de incidentes ou pedidos de autoridades | ✔ / ⚠ | Nenhum dado pessoal é guardado (o cache tem só agregados). Nas consultas genéricas, nome, apelido, e-mail, telefone, documento, endereço, pagamento e conversas são ocultados antes de sair (`src/privacy.js`, sem chave para desligar). **Ação:** procedimento de notificação em OPERACAO.md. |
| 7.1, 7.4 | Não sublicenciar a API nem armazenar conteúdo para fins concorrentes | ➖ | Uso interno da Ollyx. |
| 7.2, 7.3 | Não distribuir o conteúdo nem permitir vínculos a ele fora do aplicativo | ⚠ | Os assistentes (Claude, ChatGPT) funcionam como interface do aplicativo. **Decisão:** incluir na confirmação ao ML (cláusula 2). |
| 7.6 | Sem robôs, scraping ou coleta fora do que o ML fornece | ✔ | Só chamadas à API oficial com o token da própria conta. |
| 7.9 (viii, ix) | Não capturar nem guardar dados de cartão, nem documentos de identidade | ✔ | `card_id`, `authorization_code`, `identification`, `billing_info` e afins são ocultados; nada disso é guardado. Teste: `pedido do ML: oculta comprador, endereço e cartão`. |
| 9 | O ML pode monitorar e auditar; o desenvolvedor não pode interferir e deve cooperar | ✔ / ⚠ | Registro de cada ferramenta e acesso (sem tokens nem argumentos). **Ação:** definir quem responde a uma auditoria. |
| 10 | Segurança conforme as melhores práticas para nome, e-mail, credenciais e apelidos; avisar o ML em até 24 h sobre vulnerabilidade | ✔ / ⚠ | `npm audit` das dependências de produção: 0 vulnerabilidades (10/11/2026). Procedimento de 24 h em OPERACAO.md. Pendências abaixo. |
| 13 | Informação recebida pela API é confidencial; só usar para a finalidade; proteger como as próprias informações confidenciais | ✔ / ⚠ | Chaves e dados protegidos como acima. Mesmo ponto da cláusula 2 sobre assistentes de IA. |
| 14 | Ao revogar o acesso: parar de usar e destruir de forma irreversível as cópias intermediárias e as informações pessoais | ✔ | `npm run remote:admin -- purge:ml` apaga pedidos em cache, exportações e a conexão do ML (teste incluído). Cópias locais: apagar `cache/` e `exports/` (a pasta `.ollyx` do usuário também). |
| 16.4, 18 | Notificações pelo canal de suporte do programa; mudanças nos termos valem 10 dias após a publicação | ⚠ | Revisar os termos periodicamente e este documento a cada mudança. |

## Papel do Claude e do ChatGPT segundo os Termos

| Pergunta | Resposta pelo texto |
|---|---|
| Podem ser "Desenvolvedores"? | **Não.** Pela cláusula 1.5, Desenvolvedor é a pessoa física ou jurídica, usuária do ML, que participa do Programa. Anthropic e OpenAI não aceitaram os Termos nem participam do programa. A licença é pessoal, não sublicenciável e intransferível (2.2.1), então a Ollyx não pode estender o papel a elas. |
| Podem ser o "Aplicativo"? | **Não.** Pela 1.12, o Aplicativo é o software ou interface que **o Desenvolvedor** desenvolve, possui ou opera. O Aplicativo é o servidor MCP da Ollyx. O Claude e o ChatGPT são produtos de terceiros. |
| Onde se encaixam? | Como **clientes que consomem a resposta** do Aplicativo. O texto só tem uma categoria próxima: "prestadores de serviços" (1.15, 12 e 14), por cujos atos o Desenvolvedor responde. O texto **não diz** que enviar conteúdo a um prestador de serviços de IA seja permitido. |
| Qual cláusula pesa contra? | 2(f): não divulgar informações obtidas pela integração a terceiros que não são usuários do ML. 7.2 e 7.3: não permitir o acesso ao conteúdo fora do Aplicativo. 13: usar a informação só para a finalidade para a qual foi revelada. |
| Qual cláusula pesa a favor? | O conteúdo vai para **usuários da própria Ollyx** (a equipe que usa o assistente), e o texto não proíbe ferramentas de terceiros por si só. Além disso, dados pessoais não saem do servidor (`src/privacy.js`), então o que chega às IAs são dados comerciais da própria conta. |
| Conclusão | **Zona cinza: o texto não responde.** É por isso que a confirmação por escrito do ML (canal do 16.4) é o caminho seguro. Pergunta sugerida: "Posso usar assistentes de IA de terceiros (Claude, ChatGPT), como interface da minha conta, para consultar os dados da API da minha própria conta, com dados pessoais ocultados?" |

Fora do texto, mas relevante: se as IAs forem tratadas como prestadoras de serviços, convém usar planos empresariais em que
as conversas **não são usadas para treinar modelos** e há acordo de tratamento de dados.

## Pendências de segurança (cláusulas 2.2.2 e 10)

- **Senha do banco:** a do usuário `postgres` apareceu em conversa e imagens. Apontar `OLLYX_DATABASE_URL` para o usuário
  `mcp_app` (já criado) e só depois trocar a senha do `postgres`.
- **Plano da Vercel:** o plano Hobby é para uso não comercial; usar o Pro.
- **Aviso na conta de desenvolvedor:** o painel do ML pede "completar seus dados para seguir operando". Concluir esse passo.

## O que os Termos não definem (não inventei)

- Prazo numérico para "imediatamente" (cláusulas 2.2.2 e 6.3); só a vulnerabilidade tem prazo explícito, de 24 h (cláusula 10).
- Os limites de chamadas por período: o ML os define fora do texto.
- Se o uso por assistentes de IA de terceiros conta como divulgação ou como "outro lugar": por isso a confirmação ao ML.

## Registro de mudanças (10/11/2026)

1. Ocultação de dados pessoais em `ollyx_consultar` e `ollyx_consultar_paginas` (`src/privacy.js`).
2. Cache de pedidos com validade de 24 h, exclusão em 25 h e releitura total na tarefa diária; a resposta informa a frequência.
3. Comando `purge:ml` para a revogação do acesso.
4. Nome e textos do aplicativo sem as palavras restritas.
5. Auditoria de dependências, procedimento de incidente e este documento.
