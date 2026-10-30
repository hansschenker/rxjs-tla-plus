import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const toolchain = JSON.parse(await readFile(new URL('../toolchain.json', import.meta.url), 'utf8'));
export const jarPath = resolve(root, process.env.TLA2TOOLS_JAR || toolchain.tlaTools.file);
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const verifyJar = async () => {
  const bytes = await readFile(jarPath);
  if (digest(bytes) !== toolchain.tlaTools.sha256) {
    throw new Error('TLC checksum mismatch: ' + jarPath);
  }
  return jarPath;
};

export const setupTlc = async () => {
  try {
    await verifyJar();
    console.log('Verified pinned TLC: ' + jarPath);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (process.env.TLA2TOOLS_JAR) {
    throw new Error('TLA2TOOLS_JAR names a missing file; provide the pinned release.');
  }
  const response = await fetch(toolchain.tlaTools.url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error('TLC download failed: HTTP ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== toolchain.tlaTools.sha256) throw new Error('Downloaded TLC checksum mismatch.');
  await mkdir(dirname(jarPath), { recursive: true });
  const temporary = jarPath + '.download';
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, jarPath);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log('Downloaded and verified TLC ' + toolchain.tlaTools.release);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await setupTlc();
}
