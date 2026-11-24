import { buildFromEnv } from '../src/remote/index.js';

// Entrada única na Vercel (vercel.json reescreve todas as rotas para cá). A aplicação é criada uma vez por instância.
let app;
export default async function handler(req, res) {
  try { app ??= buildFromEnv(); }
  catch (error) {
    console.error('[ollyx] configuração inválida:', error.code || 'erro', error.message); // mensagens de OllyxError não contêm segredos
    res.statusCode = 503; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'service_unconfigured', error_description: 'Serviço sem configuração válida. Veja os logs do deploy.' }));
  }
  return app(req, res);
}
