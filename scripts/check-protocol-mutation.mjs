import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, digest } from './setup-tlc.mjs';
import { checkCoverage } from './check-coverage.mjs';
import { replayRequestProtocol } from '../runtime/replay-request-protocol.mjs';

const artifacts = resolve(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
for (const name of ['protocol-mutation.json', 'protocol-mutation.log']) {
  await rm(resolve(artifacts, name), { force: true });
}
const coverage = await checkCoverage();
const scratch = await mkdtemp(resolve(artifacts, 'protocol-mutation-'));
const testName = 'source completion waits for independent inner completion after multiple values';
const log = [];
const runFocusedTest = () => {
  const args = ['--test', '--test-reporter=tap', '--test-name-pattern=^' + testName + '$',
    'tests/request-protocol.test.mjs'];
  const result = spawnSync(process.execPath, args, {
    cwd: scratch, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.ok(!result.error && !result.signal && result.status !== null,
    'Protocol mutation test must finish normally: ' + (result.error?.message ?? result.signal));
  log.push({ command: [process.execPath, ...args], exitCode: result.status,
    output: String(result.stdout ?? '') + String(result.stderr ?? '') });
  return result;
};

try {
  for (const name of [
    'package.json', 'runtime/search-pipelines.mjs', 'runtime/replay-request-protocol.mjs',
    'tests/request-protocol.test.mjs',
  ]) {
    await mkdir(resolve(scratch, name, '..'), { recursive: true });
    await cp(resolve(root, name), resolve(scratch, name));
  }
  // This copy resolves the root's pinned RxJS package through its parent path.
  // No mutation is applied to the production adapter, tests, model or requirement.
  const baselineTest = runFocusedTest();
  assert.equal(baselineTest.status, 0, log.at(-1).output);
  assert.match(baselineTest.stdout, /ok \d+ - source completion waits for independent inner completion after multiple values/);
  assert.match(baselineTest.stdout, /# pass 1\b/);

  const path = resolve(scratch, 'runtime/search-pipelines.mjs');
  const original = await readFile(path, 'utf8');
  const importLine = "import { debounceTime, switchMap, timer } from 'rxjs';";
  const selection = 'switchMap(() => search(query))';
  assert.equal(original.split(importLine).length, 2, 'Expected one pinned pipeline import');
  assert.equal(original.split(selection).length, 2, 'Expected one immediate request selection');
  const mutated = original.replace(importLine,
    "import { debounceTime, switchMap, timer, take } from 'rxjs';")
    .replace(selection, 'switchMap(() => search(query).pipe(take(1)))');
  await writeFile(path, mutated);

  const rejected = runFocusedTest();
  assert.equal(rejected.status, 1, 'The actual RxJS pipeline regression must fail the unchanged protocol test');
  assert.match(rejected.stdout, /not ok \d+ - source completion waits for independent inner completion after multiple values/);
  assert.match(rejected.stdout, /# fail 1\b/);

  const events = [
    { type: 'Query', at: 0, id: 1 },
    { type: 'SourceComplete', at: 1 },
    { type: 'InnerNext', at: 2, id: 1, value: 'first' },
    { type: 'InnerNext', at: 3, id: 1, value: 'second' },
    { type: 'InnerComplete', at: 4, id: 1 },
  ];
  const settings = { policy: 'immediate', timerOrder: 'timer-first', delay: 2, horizon: 4 };
  const correct = replayRequestProtocol(events, settings);
  const { replayRequestProtocol: replayMutant } = await import(
    pathToFileURL(resolve(scratch, 'runtime/replay-request-protocol.mjs')).href
  );
  const actual = replayMutant(events, settings);
  const notifications = (result) => result.notifications.map(({ at, kind, id, index }) =>
    kind === 'N' ? { at, kind, id, index } : { at, kind });
  assert.deepEqual(notifications(correct), [
    { at: 2, kind: 'N', id: 1, index: 1 },
    { at: 3, kind: 'N', id: 1, index: 2 },
    { at: 4, kind: 'C' },
  ]);
  assert.deepEqual(notifications(actual), [
    { at: 2, kind: 'N', id: 1, index: 1 }, { at: 2, kind: 'C' },
  ]);
  assert.equal(actual.requests[0].stopReason, 'unsubscribe');
  assert.equal(await readFile(resolve(root, 'runtime/search-pipelines.mjs'), 'utf8'), original);

  const report = {
    recordedAt: new Date().toISOString(), reviewedSourceCommit: coverage.reviewedCommit,
    classification: 'implementation bug under the unchanged independent request notification contract',
    mutation: 'wrap the immediate policy request in take(1), in a disposable copy',
    originalSha256: digest(original), mutatedSha256: digest(mutated),
    inputs: Object.fromEntries(await Promise.all([
      'scripts/check-protocol-mutation.mjs', 'runtime/search-pipelines.mjs',
      'runtime/replay-request-protocol.mjs', 'tests/request-protocol.test.mjs',
    ].map(async name => [name, digest(await readFile(resolve(root, name)))]))),
    testName, baselineTestExit: baselineTest.status, mutantTestExit: rejected.status,
    events, settings, correct, mutant: actual,
    interpretation: 'The first next incorrectly completes output, unsubscribes the request, and loses its second value. '
      + 'The model-only CompleteOnNext mutation separately exercises NextKeepsRequestActive; '
      + 'the two mutations are complementary fault checks, not matching teardown traces.',
    productionFiles: 'unchanged; disposable copy removed',
  };
  await writeFile(resolve(artifacts, 'protocol-mutation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Protocol mutation: unchanged test passed for the baseline and rejected take(1); '
    + 'the mutated RxJS pipeline completed early and lost the second value.');
} finally {
  await writeFile(resolve(artifacts, 'protocol-mutation.log'), log.map(entry =>
    JSON.stringify({ command: entry.command, exitCode: entry.exitCode }) + '\n' + entry.output).join('\n'));
  await rm(scratch, { recursive: true, force: true });
}
