import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, digest } from './setup-tlc.mjs';

const roots = ['runtime', 'scripts', 'tests', 'experiments', '.github/workflows'];
const rootFiles = ['package.json', 'package-lock.json', 'toolchain.json', 'experiments.json', 'upstream-lock.json'];
const covered = (path) => rootFiles.includes(path)
  || (roots.some((prefix) => path.startsWith(prefix + '/'))
    && !path.split('/').some((part) => ['node_modules', 'artifacts', '.git'].includes(part))
    && /\.(mjs|cjs|js|ts|tla|cfg|json|ya?ml)$/.test(path));

export const snapshotCoverage = async (base = root) => {
  const paths = [];
  const walk = async (directory) => {
    let entries;
    try { entries = await readdir(resolve(base, directory), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (['node_modules', 'artifacts', '.git'].includes(entry.name)) continue;
      const path = directory + '/' + entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && covered(path)) paths.push(path);
    }
  };
  for (const directory of roots) await walk(directory);
  for (const path of rootFiles) {
    try { await readFile(resolve(base, path)); paths.push(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return Object.fromEntries(await Promise.all(paths.sort().map(async (path) => [
    path, digest(await readFile(resolve(base, path))),
  ])));
};

export const coverageDifference = (expected, actual) => {
  const paths = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  return paths.flatMap((path) => expected[path] === actual[path] ? [] : [{
    path, change: !(path in expected) ? 'added' : !(path in actual) ? 'removed' : 'changed',
  }]);
};

const git = (...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Git failed: ' + (result.error?.message || result.stderr));
  return result.stdout;
};

const verifyCommittedInventory = (reviewedCommit, files) => {
  assert.equal(git('rev-parse', '--verify', reviewedCommit + '^{commit}').trim(), reviewedCommit);
  const committed = git('ls-tree', '-r', '--name-only', reviewedCommit).trim().split('\n').filter(covered).sort();
  assert.deepEqual(Object.keys(files).sort(), committed, 'Covered files must match the reviewed commit inventory.');
  for (const [path, hash] of Object.entries(files)) {
    assert.equal(digest(git('show', reviewedCommit + ':' + path)), hash,
      'File hash differs from the reviewed commit: ' + path);
  }
};

export const recordCoverage = async (revision) => {
  // Recording is a deliberate review step. Normal verification never updates this pin.
  const reviewedCommit = git('rev-parse', '--verify', revision + '^{commit}').trim();
  const files = await snapshotCoverage();
  verifyCommittedInventory(reviewedCommit, files);
  const record = {
    schemaVersion: 1, reviewedCommit, reviewedAt: new Date().toISOString(),
    meaning: 'Reviewed source identity and change detection; not a proof of model/implementation correspondence.',
    files,
  };
  await mkdir(resolve(root, 'verification'), { recursive: true });
  await writeFile(resolve(root, 'verification/coverage.json'), JSON.stringify(record, null, 2) + '\n');
  console.log('Recorded reviewed source ' + reviewedCommit + ' (' + Object.keys(files).length + ' files).');
  return record;
};

export const checkCoverage = async () => {
  const record = JSON.parse(await readFile(resolve(root, 'verification/coverage.json'), 'utf8'));
  assert.match(record.reviewedCommit, /^[a-f0-9]{40}$/);
  const difference = coverageDifference(record.files, await snapshotCoverage());
  if (difference.length) {
    throw new Error('Verification review required; do not refresh the pin just to pass.\n'
      + difference.map(({ path, change }) => change + ': ' + path).join('\n'));
  }
  verifyCommittedInventory(record.reviewedCommit, record.files);
  console.log('Coverage in sync with reviewed source ' + record.reviewedCommit + ' (' + Object.keys(record.files).length + ' files).');
  return record;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--record' && process.argv.length === 4) await recordCoverage(process.argv[3]);
    else if (process.argv.length === 2) await checkCoverage();
    else throw new Error('Usage: node ' + relative(root, fileURLToPath(import.meta.url)) + ' [--record REVIEWED_COMMIT]');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
