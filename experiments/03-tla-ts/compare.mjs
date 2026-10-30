import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { check, parseConfig } from 'tla-ts';
import { digest, root, verifyJar } from '../../scripts/setup-tlc.mjs';
import { replaySearchTrace } from '../../runtime/replay-search-trace.mjs';

const jarPath = await verifyJar();
const configurations = JSON.parse(readFileSync(join(root, 'experiments.json'), 'utf8'));
const reports = [];
let searchReplay;

// This adapter consumes typed scalar state fields, not TLC's console text.
// It is intentionally specific to SearchFreshness, not a general RxJS compiler.
function replayStructuredSearchCounterexample(result, config) {
  const states = result.violation.trace.map(({ state }, index) => {
    for (const name of ['now', 'lastId', 'latestRaw', 'pending', 'active']) {
      assert.ok(Number.isSafeInteger(state[name]), `Trace state ${index}: invalid ${name}`);
    }
    assert.equal(typeof state.badEmission, 'boolean');
    assert.ok(['Init', 'Query', 'Timer', 'Result', 'Cancel', 'Tick'].includes(state.lastEvent));
    return {
      at: state.now, event: state.lastEvent, id: state.lastId,
      latestRaw: state.latestRaw, pending: state.pending, active: state.active,
      badEmission: state.badEmission,
    };
  });
  assert.equal(states[0].event, 'Init');
  assert.equal(states.at(-1).badEmission, true);
  const delayConstant = parseConfig(config).constants.find(item => item.name === 'Delay');
  assert.equal(delayConstant?.value?.kind, 'Number');
  const delay = delayConstant.value.value;
  const horizon = states.at(-1).at;
  const events = states
    .filter(state => ['Query', 'Result', 'Cancel'].includes(state.event))
    .map(state => ({
      type: state.event === 'Cancel' ? 'Unsubscribe' : state.event,
      at: state.at,
      id: state.id,
    }));
  const runtime = replaySearchTrace(events, { policy: 'debounced', delay, horizon });
  const outputs = states.filter(state => state.event === 'Result')
    .map(state => ({ at: state.at, id: state.id }));
  const starts = states.filter(state => state.event === 'Timer')
    .map(state => ({ start: state.at, id: state.id }));
  const violations = states
    .filter(state => state.event === 'Result' && state.id !== state.latestRaw)
    .map(state => ({ at: state.at, resultId: state.id, latestQueryId: state.latestRaw }));
  assert.ok(violations.length > 0);
  assert.deepEqual(runtime.outputs.map(({ at, id }) => ({ at, id })), outputs);
  assert.deepEqual(runtime.requests.map(({ start, id }) => ({ start, id })), starts);
  assert.deepEqual(runtime.violations, violations);
  const corrected = replaySearchTrace(events, { policy: 'immediate', delay, horizon });
  assert.equal(corrected.violations.length, 0,
    'the immediate-cancellation candidate must suppress stale delivery for this trace');
  return {
    delay, horizon, states, events,
    runtime: { outputs: runtime.outputs, requests: runtime.requests, violations: runtime.violations },
    corrected: { outputs: corrected.outputs, requests: corrected.requests, violations: corrected.violations },
  };
}

for (const expected of configurations) {
  const modelPath = join(root, expected.module);
  const configPath = join(root, expected.config);
  const source = readFileSync(modelPath, 'utf8');
  const config = readFileSync(configPath, 'utf8');
  const javascriptResult = await check({ source, config, workers: 1, seed: 0n });
  const expectedStatus = expected.expect === 'pass' ? 'success' : 'invariant-violation';
  const expectedExitCode = expected.expect === 'pass' ? 0 : 12;
  assert.equal(javascriptResult.status, expectedStatus,
    `${expected.id}: unexpected tla-ts verdict`);
  if (expected.invariant) {
    assert.equal(javascriptResult.violation?.name, expected.invariant,
      `${expected.id}: tla-ts must detect the intended invariant`);
  }

  const metadataDirectory = mkdtempSync(join(tmpdir(), 'rxjs-tla-ts-comparison-'));
  let tlc;
  try {
    tlc = spawnSync('java', [
      '-XX:+UseParallelGC', '-cp', jarPath, 'tlc2.TLC',
      '-workers', '1', '-seed', '0', '-fp', '0',
      '-metadir', metadataDirectory, '-config', configPath, modelPath,
    ], { cwd: dirname(modelPath), encoding: 'utf8', timeout: 30_000 });
  } finally {
    rmSync(metadataDirectory, { recursive: true, force: true });
  }
  if (tlc.error) throw tlc.error;
  const output = `${tlc.stdout}\n${tlc.stderr}`;
  assert.equal(tlc.status, expectedExitCode,
    `${expected.id}: unexpected TLC exit status\n${output}`);
  if (expected.invariant) {
    assert.ok(output.includes(`Invariant ${expected.invariant} is violated`),
      `${expected.id}: TLC failed for a different reason\n${output}`);
  } else {
    assert.ok(output.includes('Model checking completed. No error has been found.'),
      `${expected.id}: TLC did not finish successfully\n${output}`);
  }

  const counts = output.match(
    /(\d+) states generated, (\d+) distinct states found, (\d+) states left on queue\./,
  );
  assert.ok(counts, `TLC did not report state counts\n${output}`);
  const depth = output.match(/depth of the complete state graph search is (\d+)/);
  assert.ok(depth, `TLC did not report search depth\n${output}`);
  const actualCounts = {
    generated: javascriptResult.generatedStates,
    distinct: javascriptResult.distinctStates,
    depth: javascriptResult.depth,
  };
  const tlcCounts = {
    generated: Number(counts[1]), distinct: Number(counts[2]), depth: Number(depth[1]),
  };
  assert.deepEqual(actualCounts, tlcCounts,
    `${expected.id}: tla-ts and TLC explored different state counts or depths`);
  const report = {
    id: expected.id,
    module: expected.module,
    config: expected.config,
    modelSha256: digest(source),
    configSha256: digest(config),
    status: javascriptResult.status,
    invariant: javascriptResult.violation?.name ?? null,
    ...actualCounts,
    tlcExitCode: tlc.status,
  };
  if (expected.id === 'search-debounced') {
    searchReplay = replayStructuredSearchCounterexample(javascriptResult, config);
    report.runtimeReplay = 'structured trace reproduces output times, request starts, and stale delivery in RxJS';
  }
  reports.push(report);
  console.log(JSON.stringify(report));
}

assert.ok(searchReplay, 'the manifest must include the structured search-counterexample replay');
const artifactsDirectory = join(root, 'artifacts');
mkdirSync(artifactsDirectory, { recursive: true });
writeFileSync(join(artifactsDirectory, 'tla-ts-results.json'), JSON.stringify({
  recordedAt: new Date().toISOString(),
  tlaTsVersion: '0.0.3',
  node: process.version,
  reports,
  searchReplay,
}, null, 2) + '\n');
console.log(`All ${reports.length} unchanged manifest cases agree between tla-ts 0.0.3 and TLC.`);
console.log('The structured FreshEmission counterexample reproduces stale delivery in real RxJS.');
