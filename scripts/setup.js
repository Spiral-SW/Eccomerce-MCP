import { copyFile, constants } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectDir } from '../src/config.js';
import { generateConfigs } from './generate-config.js';
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) throw new Error('Instale Node.js 22 ou posterior.');
const destination = process.env.OLLYX_CONFIG_FILE ? resolve(process.env.OLLYX_CONFIG_FILE) : resolve(projectDir, '.env');
try {
  await copyFile(resolve(projectDir, '.env.example'), destination, constants.COPYFILE_EXCL);
  console.log('Arquivo de conexão criado. Preencha as credenciais somente neste computador.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Arquivo de conexão existente preservado.');
}
await generateConfigs({ configFile: destination });
console.log('Claude Desktop: use config/claude_desktop_config.json ou a extensão .mcpb.');
