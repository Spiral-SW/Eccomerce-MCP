# Ollyx no Claude Desktop e em outros PCs

A extensão Ollyx é um servidor MCP local. Instale o mesmo arquivo ollyx-mcp.mcpb em cada computador. O pacote inclui o código, os catálogos e as bibliotecas; não inclui tokens, senhas, arquivos .env pessoais nem os caminhos da máquina original.

## Instalar a extensão

1. Copie ollyx-mcp.mcpb para o PC desejado, com Claude Desktop atualizado.
2. No Claude, abra Configurações > Desktop app > Manage ao lado de Extensions. Em versões anteriores, Configurações > Extensions.
3. Abra Advanced settings > Install Extension e selecione ollyx-mcp.mcpb.
4. Na configuração da extensão Ollyx, selecione o arquivo de conexão .env desse PC. Veja as opções abaixo.
5. Habilite a extensão e abra uma conversa. Se necessário, encerre e reabra completamente o Claude.

Esse é um pacote personalizado para instalação direta, sem publicação no diretório de extensões. Políticas da empresa podem exigir que um administrador permita extensões personalizadas.

A extensão usa o runtime Node.js do Claude Desktop; a compatibilidade declarada requer Node.js 22 ou superior. Foi validada por protocolo MCP em Windows. Os caminhos para macOS estão preparados; não houve execução em um Mac nesta entrega.

## Preparar a conexão em cada PC

O arquivo .env fica fora da pasta da extensão. Os arquivos OAuth e outros caminhos relativos são resolvidos a partir da pasta desse arquivo.

**Quando já existe uma integração local da Ollyx:** copie o modelo de conexão e preencha BLING_SHARED_ENV_FILE e MELI_SHARED_ENV_FILE com os caminhos da integração naquele PC. Não copie os caminhos da máquina original. A integração de origem mantém os tokens renovados; o MCP apenas os lê.

**Para uma instalação independente:** use o ZIP de fontes para preparar o arquivo e autorizar as APIs. Instale Node.js 22+ nessa etapa de preparação e, dentro da pasta extraída, execute:

~~~text
npm ci --ignore-scripts
npm run setup
~~~

Preencha localmente no .env os campos CLIENT_ID, CLIENT_SECRET e REDIRECT_URI de cada provedor. Depois execute:

~~~text
npm run auth -- bling
npm run auth -- meli
~~~

Abra o link que o terminal mostrar, autorize a conta e cole a URL completa do retorno naquele mesmo terminal. No Bling, faça isso imediatamente: o código é de curta duração. Os arquivos OAuth serão salvos na pasta secrets ao lado do .env e renovados pelo MCP.

Selecione esse .env nas configurações da extensão do Claude. Mantenha a pasta do .env e dos arquivos OAuth em um local permanente. A pasta do ZIP usada apenas para preparar a configuração pode ficar separada da extensão.

Em outro computador, faça uma autorização própria. Distribua o pacote público; não distribua o .env preenchido nem copie refresh tokens em uso.

**Para testar rapidamente:** a extensão também aceita tokens de acesso temporários nos campos protegidos Token do Bling e Token do Mercado Livre. Eles expiram e não são renovados nesse modo. Para uso contínuo, prefira o arquivo com OAuth ou uma integração que já renove os tokens.

## Alternativa: configuração JSON

Se preferir o servidor por arquivos, prepare o ZIP com npm ci e npm run setup. O comando gera config/claude_desktop_config.json usando os caminhos e o executável Node do computador atual.

No Claude Desktop, abra a configuração de desenvolvedor e incorpore apenas a entrada mcpServers.ollyx do arquivo gerado, preservando os outros servidores e opções.

Locais de configuração documentados:

- Windows: %APPDATA%\Claude\claude_desktop_config.json.
- macOS: ~/Library/Application Support/Claude/claude_desktop_config.json.
- Versões Windows empacotadas podem guardar o perfil no LocalCache do aplicativo; prefira abrir a configuração pelo próprio Claude.

Após mover a pasta, gere a configuração novamente. Escolha uma das formas de instalação para evitar duas cópias do Ollyx na mesma conversa.

## Usar

Peça ao Claude:

- Use o Ollyx para verificar as conexões.
- Consulte meus pedidos de hoje no Bling.
- Consulte o estoque do SKU ABC123.
- Liste meus anúncios ativos do Mercado Livre.
- Mostre os pedidos pagos do Mercado Livre no período informado.

As ferramentas são ollyx_status, ollyx_recursos, ollyx_consultar, ollyx_consultar_paginas, ollyx_curva_abc e ollyx_depara_sku.

As operações de negócio continuam somente de leitura. A cobertura depende das permissões das APIs e do usuário conectado. Uma página de resultados não representa toda a base; o retorno informa quando continuar a paginação.

## Teste e diagnóstico

Primeiro peça ollyx_status (com verificar=true para testar os escopos reais). Depois consulte um recurso simples de cada provedor.

- not_configured: configure um arquivo ou token nos ajustes da extensão.
- invalid_config_file: confira se o .env selecionado existe neste PC.
- reconnect_required: renove a autorização na integração de origem ou use o assistente OAuth local.
- HTTP 403: o recurso foi negado pela API; outros recursos autorizados continuam disponíveis.
- Se a extensão não iniciar, verifique o runtime, a configuração e os logs do Claude Desktop.

Esta versão atende ao Claude Desktop local. Não foi criado um endereço público de servidor remoto.

## Referências oficiais

- [Instalar extensões locais personalizadas no Claude](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
- [Conectar servidores MCP locais](https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers)
- [Formato MCPB](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md)
