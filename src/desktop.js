// Campos opcionais vazios não impedem que o arquivo selecionado forneça as credenciais.
import { main } from './server.js';
for (const key of ['OLLYX_CONFIG_FILE', 'BLING_ACCESS_TOKEN', 'MELI_ACCESS_TOKEN']) {
  if (!process.env[key]?.trim()) delete process.env[key];
}
main().catch(() => {
  console.error('Não foi possível iniciar o Ollyx. Confira o arquivo de conexão nas configurações da extensão.');
  process.exitCode = 1;
});
