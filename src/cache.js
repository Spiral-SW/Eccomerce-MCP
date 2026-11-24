import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Lê JSON; arquivo ausente, vazio ou corrompido devolve null (o cache é sempre refazível). */
export async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

/** No Windows, rename sobre arquivo em uso (outra escrita, antivírus) falha com EPERM/EBUSY/EACCES: tenta de novo. */
async function renameRetry(from, to, tries = 8) {
  for (let i = 0; ; i++) {
    try { return await rename(from, to); }
    catch (error) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await new Promise(r => setTimeout(r, 15 * (i + 1) + Math.random() * 20));
    }
  }
}

/** Grava de forma atômica (arquivo temporário único + rename): leitores nunca veem JSON pela metade. */
export async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try { await writeFile(tmp, JSON.stringify(value)); await renameRetry(tmp, file); }
  catch (error) { await rm(tmp, { force: true }).catch(() => {}); throw error; }
}

/** Grava texto (ex.: CSV) de forma atômica. */
export async function writeTextAtomic(file, text) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try { await writeFile(tmp, text); await renameRetry(tmp, file); }
  catch (error) { await rm(tmp, { force: true }).catch(() => {}); throw error; }
}

/** Chamadas idênticas e simultâneas compartilham a mesma execução (evita ler a API duas vezes). */
export function singleFlight() {
  const running = new Map();
  return (key, run) => {
    if (running.has(key)) return running.get(key);
    const promise = Promise.resolve().then(run).finally(() => running.delete(key));
    running.set(key, promise);
    return promise;
  };
}
