import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { root, verifyJar, digest } from './setup-tlc.mjs';
import { checkCoverage } from './check-coverage.mjs';
import { classifyResult } from './check-models.mjs';

// This deliberately broken implementation exists only in a disposable directory.
// The public contract and the FreshEmission invariant are never weakened.
const coverage = await checkCoverage();
const jar = await verifyJar();
const artifacts = resolve(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const scratch = await mkdtemp(resolve(artifacts, 'maintenance-'));
const log = [];
const run = (command, args, expected = 0) => {
  const result = spawnSync(command, args, {
    cwd: scratch, encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TLA2TOOLS_JAR: jar },
  });
  if (result.error || result.signal || result.status === null) throw new Error('Mutation command did not finish: ' + (result.error?.message || result.signal));
  log.push({ command: [command, ...args], exitCode: result.status, output: String(result.stdout || '') + String(result.stderr || '') });
  if (expected !== null) assert.equal(result.status, expected, log.at(-1).output);
  return result;
};
const commit = (message) => {
  run('git', ['add', '.']);
  run('git', ['-c', 'user.name=RxJS TLA+ experiment', '-c', 'user.email=experiment@example.invalid', 'commit', '-m', message]);
  return run('git', ['rev-parse', 'HEAD']).stdout.trim();
};

try {
  const paths = ['runtime', 'scripts', 'tests', 'experiments', '.github', '.agents', 'verification',
    'package.json', 'package-lock.json', 'toolchain.json', 'experiments.json', 'upstream-lock.json'];
  for (const path of paths) {
    await cp(resolve(root, path), resolve(scratch, path), {
      recursive: true,
      filter: (source) => !relative(root, source).split(/[\\/]/).includes('node_modules'),
    });
  }
  // Keeping the copy under artifacts lets ordinary Node resolution find the root's pinned RxJS.
  await writeFile(resolve(scratch, '.gitignore'), 'artifacts/\nnode_modules/\n.tools/\n');
  run('git', ['init', '-b', 'main']);
  const baselineCommit = commit('Controlled maintenance baseline');
  const pipelinePath = resolve(scratch, 'runtime/search-pipelines.mjs');
  const original = await readFile(pipelinePath, 'utf8');
  const marker = 'export function createImmediateCancelSearch$(queries$, search, delay, scheduler) {\n';
  assert.equal(original.split(marker).length, 2, 'Mutation target must be unique.');
  const mutated = original.replace(marker, marker
    + '  return createDebouncedSearch$(queries$, search, delay, scheduler); // deliberate regression\n');
  await writeFile(pipelinePath, mutated);
  const mutantCommit = commit('Introduce delayed cancellation for the maintenance drill');

  const drift = run(process.execPath, ['scripts/check-coverage.mjs'], 1);
  assert.match(drift.stderr, /changed: runtime\/search-pipelines\.mjs/);
  run(process.execPath, ['scripts/check-models.mjs', 'search-immediate']);
  const runtime = run(process.execPath, ['--test', '--test-reporter=tap', 'tests/search-freshness.test.mjs'], null);
  assert.equal(runtime.status, 1, 'Real RxJS regression tests must reject the implementation mutation.');
  assert.match(runtime.stdout, /# fail [1-9]\d*/);
  assert.match(runtime.stdout, /not ok \d+ - the immediate policy closes the old request when raw input arrives/);

  const configPath = resolve(scratch, 'experiments/02-search-freshness/immediate.cfg');
  const config = await readFile(configPath, 'utf8');
  assert.ok(config.includes('Policy = "immediate"'));
  await writeFile(configPath, config.replace('Policy = "immediate"', 'Policy = "debounced"'));
  const modelSyncCommit = commit('Align model policy with changed implementation; preserve freshness requirement');
  const meta = await mkdtemp(resolve(scratch, 'tlc-'));
  const changedModel = run('java', ['-XX:+UseParallelGC', '-Xmx512m', '-cp', jar, 'tlc2.TLC',
    '-workers', '1', '-fp', '0', '-seed', '1', '-metadir', meta,
    '-config', configPath, resolve(scratch, 'experiments/02-search-freshness/SearchFreshness.tla')], 12);
  classifyResult(changedModel, { id: 'maintenance-aligned-model', expect: 'violation', invariant: 'FreshEmission' });
  const patch = run('git', ['diff', baselineCommit, 'HEAD', '--', 'runtime/search-pipelines.mjs',
    'experiments/02-search-freshness/immediate.cfg']).stdout;
  const result = {
    recordedAt: new Date().toISOString(), reviewedSourceCommit: coverage.reviewedCommit,
    classification: 'bug under the unchanged immediate-cancellation contract',
    baselineCommit, mutantCommit, modelSyncCommit,
    mutationFile: 'runtime/search-pipelines.mjs', originalSha256: digest(original), mutatedSha256: digest(mutated),
    observations: {
      coverageGuard: 'detected changed runtime source',
      unchangedModel: 'passed, demonstrating that a green stale model can miss implementation drift',
      independentRuntimeChecks: 'rejected the implementation regression',
      alignedModel: 'violated the unchanged FreshEmission invariant',
      productionFiles: 'unchanged; scratch implementation and model discarded',
    },
    patch,
  };
  await writeFile(resolve(artifacts, 'maintenance-drill.json'), JSON.stringify(result, null, 2) + '\n');
  await writeFile(resolve(artifacts, 'maintenance-drill.log'), log.map((entry) =>
    JSON.stringify({ command: entry.command, exitCode: entry.exitCode }) + '\n' + entry.output).join('\n'));
  console.log('Maintenance drill: drift detected; stale model passed; runtime rejected regression; aligned model found FreshEmission.');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
