import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { config as dotenv } from 'dotenv';
import { OllyxError } from './errors.js';
export const projectDir = fileURLToPath(new URL('../', import.meta.url));
export function loadConfig(env = process.env, loadFile = true) {
  const explicitFile = env.OLLYX_CONFIG_FILE?.trim();
  const configFile = explicitFile ? resolve(explicitFile) : resolve(projectDir, '.env');
  const configDir = dirname(configFile);
  if (loadFile) {
    const result = dotenv({ path: configFile, processEnv: env, quiet: true });
    if (result.error && (explicitFile || result.error.code !== 'ENOENT')) {
      throw new OllyxError('invalid_config_file', 'Não foi possível ler o arquivo de conexão selecionado. Confira o caminho nas configurações da extensão.');
    }
  }
  const number = (key, fallback, min, max) => {
    const n = Number(env[key] || fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error('Configuração inválida: ' + key);
    return n;
  };
  const provider = (prefix, name) => ({
    name, accessToken: env[prefix + '_ACCESS_TOKEN'] || '',
    sharedEnvFile: env[prefix + '_SHARED_ENV_FILE'] ? resolve(configDir, env[prefix + '_SHARED_ENV_FILE']) : '',
    tokenFile: resolve(configDir, env[prefix + '_TOKEN_FILE'] || 'secrets/' + name + '.json'),
    // Mercado Livre também aceita o prefixo ML_ (nome usado em outros sistemas da Ollyx); MELI_ tem prioridade.
    clientId: env[prefix + '_CLIENT_ID'] || (name === 'meli' ? env.ML_CLIENT_ID : '') || '',
    clientSecret: env[prefix + '_CLIENT_SECRET'] || (name === 'meli' ? env.ML_CLIENT_SECRET : '') || '',
    redirectUri: env[prefix + '_REDIRECT_URI'] || '',
    useDatabase: env[prefix + '_USE_OLLYX_DATABASE'] === 'true',
  });
  const dataDir = env.OLLYX_DATA_DIR?.trim() ? resolve(env.OLLYX_DATA_DIR.trim()) : join(homedir(), '.ollyx');
  return {
    providers: { bling: provider('BLING', 'bling'), meli: provider('MELI', 'meli') },
    // Dados gerados (cache e CSV) ficam fora da pasta do pacote, que é substituída a cada atualização da extensão.
    dataDir,
    apiLogDir: join(dataDir, 'logs'),
    apiLogging: env.OLLYX_API_LOG !== '0',
    databaseUrl: env.OLLYX_DATABASE_URL || '',
    timeoutMs: number('OLLYX_TIMEOUT_MS', 20000, 1000, 120000),
    maxResponseBytes: number('OLLYX_MAX_RESPONSE_BYTES', 2097152, 1024, 10485760),
  };
}
