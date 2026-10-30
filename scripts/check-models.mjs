import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { root, verifyJar, digest, toolchain } from './setup-tlc.mjs';
import { replaySearchTrace } from '../runtime/replay-search-trace.mjs';
import { decodeLifecycleTrace, lifecycleReplaySettings, replayLifecycleEvidence, lifecycleEvidenceMarkdown } from './lifecycle-evidence.mjs';
import {
  decodeRequestProtocolTrace, requestProtocolReplaySettings,
  replayRequestProtocolEvidence, requestProtocolEvidenceMarkdown,
} from './request-protocol-evidence.mjs';

// This parser intentionally accepts only this experiment's scalar trace fields.
export const decodeSearchTrace = (output) => {
  const headers = [...output.matchAll(/^State (\d+):[^\n]*\n/gm)];
  const states = headers.map((match, index) => {
    const body = output.slice(match.index + match[0].length, headers[index + 1]?.index ?? output.length);
    const scalar = (name) => {
      const line = body.split('\n').find((value) => value.startsWith('/\\ ' + name + ' = '));
      if (!line) throw new Error('Missing trace field ' + name + ' in state ' + match[1]);
      const value = line.slice(('/\\ ' + name + ' = ').length);
      if (/^-?\d+$/.test(value)) return Number(value);
      if (value === 'TRUE') return true;
      if (value === 'FALSE') return false;
      if (/^"[^"]*"$/.test(value)) return JSON.parse(value);
      throw new Error('Unsupported scalar trace value: ' + value);
    };
    return {
      step: Number(match[1]), at: scalar('now'), event: scalar('lastEvent'),
      id: scalar('lastId'), latestRaw: scalar('latestRaw'), pending: scalar('pending'),
      active: scalar('active'), badEmission: scalar('badEmission'),
    };
  });
  if (states.length < 2 || states[0].event !== 'Init' || !states.at(-1).badEmission) {
    throw new Error('Expected a complete FreshEmission counterexample.');
  }
  return states;
};

export const classifyResult = (result, expected) => {
  if (result.error || result.signal || result.status === null) {
    throw new Error('Checker did not finish: ' + (result.error?.message || result.signal));
  }
  const output = String(result.stdout || '') + String(result.stderr || '');
  if (expected.expect === 'pass') {
    if (result.status !== 0 || !output.includes('Model checking completed. No error has been found.')) {
      throw new Error(expected.id + ': expected a completed successful model check; exit ' + result.status);
    }
  } else if (result.status !== 12 || !output.includes('Error: Invariant ' + expected.invariant + ' is violated.')) {
    throw new Error(expected.id + ': expected exactly invariant ' + expected.invariant + '; exit ' + result.status);
  }
  return output;
};

const snapshotFiles = async (paths) => Object.fromEntries(await Promise.all(paths.map(async (path) => [
  path, digest(await readFile(resolve(root, path))),
])));

export const checkModels = async () => {
  const jar = await verifyJar();
  const all = JSON.parse(await readFile(resolve(root, 'experiments.json'), 'utf8'));
  const selected = process.argv.slice(2);
  const cases = selected.length ? all.filter((item) => selected.includes(item.id)) : all;
  if (!cases.length || selected.some((id) => !all.some((item) => item.id === id))) {
    throw new Error('Unknown experiment ID.');
  }
  const artifacts = resolve(root, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  // A failed rerun must not leave an older successful summary looking current.
  for (const path of ['model-results.json', 'search-counterexample.json', 'search-counterexample.md']) {
    await rm(resolve(artifacts, path), { force: true });
  }
  await rm(resolve(artifacts, 'lifecycle'), { recursive: true, force: true });
  await rm(resolve(artifacts, 'request-protocol'), { recursive: true, force: true });
  const reports = [];
  for (const item of cases) {
    const meta = await mkdtemp(resolve(tmpdir(), 'rxjs-tla-'));
    const args = ['-XX:+UseParallelGC', '-Xmx512m', '-cp', jar, 'tlc2.TLC',
      '-workers', '1', '-fp', '0', '-seed', '1', '-metadir', meta,
      '-config', resolve(root, item.config), resolve(root, item.module)];
    const started = Date.now();
    let result;
    try {
      result = spawnSync('java', args, {
        cwd: dirname(resolve(root, item.module)), encoding: 'utf8',
        timeout: 45000, maxBuffer: 8 * 1024 * 1024,
      });
    } finally {
      await rm(meta, { recursive: true, force: true });
    }
    const raw = String(result.stdout || '') + String(result.stderr || '');
    await writeFile(resolve(artifacts, item.id + '.log'), raw);
    const output = classifyResult(result, item);
    const counts = output.match(/(\d+) states generated, (\d+) distinct states found, (\d+) states left on queue/);
    if (!counts) throw new Error('Missing state counts for ' + item.id);
    const report = {
      ...item, outcome: item.expect === 'pass' ? 'model-checked' : 'expected-invariant-violation',
      exitCode: result.status, elapsedMs: Date.now() - started,
      generatedStates: Number(counts[1]), distinctStates: Number(counts[2]),
      statesLeft: Number(counts[3]), logSha256: digest(output),
      inputs: await snapshotFiles([item.module, item.config]),
    };
    if (item.id === 'search-debounced') {
      const states = decodeSearchTrace(output);
      const events = states.filter((state) => ['Query', 'Result', 'Cancel'].includes(state.event))
        .map((state) => ({ type: state.event === 'Cancel' ? 'Unsubscribe' : state.event, at: state.at, id: state.id }));
      const horizon = states.at(-1).at;
      const runtime = replaySearchTrace(events, { policy: 'debounced', delay: 3, horizon });
      const expectedOutputs = states.filter((state) => state.event === 'Result').map((state) => ({ at: state.at, id: state.id }));
      const expectedStarts = states.filter((state) => state.event === 'Timer').map((state) => ({ id: state.id, start: state.at }));
      assert.deepEqual(runtime.outputs.map(({ at, id }) => ({ at, id })), expectedOutputs);
      assert.deepEqual(runtime.requests.map(({ id, start }) => ({ id, start })), expectedStarts);
      assert.ok(runtime.violations.length > 0, 'Counterexample must fail the same freshness property in real RxJS.');
      const corrected = replaySearchTrace(events, { policy: 'immediate', delay: 3, horizon });
      assert.equal(corrected.violations.length, 0);
      assert.equal(corrected.outputs.length, 0);
      report.runtimeReplay = 'same output times, request IDs, request start times, and freshness violation';
      await writeFile(resolve(artifacts, 'search-counterexample.json'), JSON.stringify({ states, events, runtime, corrected }, null, 2) + '\n');
      const rows = states.filter((state) => state.event !== 'Tick').map((state) => {
        const action = state.event === 'Timer' ? 'Subscribe request ' + state.id
          : state.event === 'Result' ? 'Deliver result ' + state.id + '; complete inner'
          : state.event === 'Cancel' ? 'Release timer and inner' : 'No result';
        return '| ' + state.at + ' | ' + state.event + (state.id ? ' ' + state.id : '')
          + ' | raw=' + state.latestRaw + ', pending=' + state.pending + ', active=' + state.active
          + ' | ' + action + ' |';
      });
      await writeFile(resolve(artifacts, 'search-counterexample.md'),
        '# TLC counterexample replayed against RxJS 7.8.2\n\n'
        + 'The table omits Tick-only states. Equal-time external events retain their sequence order.\n\n'
        + '| Virtual time | Input / scheduler event | State after reaction | Output / resource action |\n'
        + '|---:|---|---|---|\n' + rows.join('\n') + '\n\n'
        + 'The baseline delivers request 1 after raw query 2. The immediate-cancellation candidate suppresses that delivery for the same external trace.\n');
    }
    if (item.replay === 'lifecycle') {
      const states = decodeLifecycleTrace(output);
      const settings = lifecycleReplaySettings(await readFile(resolve(root, item.config), 'utf8'));
      const evidence = replayLifecycleEvidence(states, settings);
      await mkdir(resolve(artifacts, 'lifecycle'), { recursive: true });
      await writeFile(resolve(artifacts, 'lifecycle', item.id + '.json'),
        JSON.stringify({ id: item.id, invariant: item.invariant, purpose: item.purpose, ...evidence }, null, 2) + '\n');
      await writeFile(resolve(artifacts, 'lifecycle', item.id + '.md'), lifecycleEvidenceMarkdown(item.id, evidence));
      report.runtimeReplay = 'same accepted queries, request starts/stops, notifications, freshness, and settled source/output ownership';
    }
    if (item.replay === 'request-protocol') {
      const states = decodeRequestProtocolTrace(output);
      const settings = requestProtocolReplaySettings(await readFile(resolve(root, item.config), 'utf8'));
      const evidence = replayRequestProtocolEvidence(states, settings);
      await mkdir(resolve(artifacts, 'request-protocol'), { recursive: true });
      await writeFile(resolve(artifacts, 'request-protocol', item.id + '.json'),
        JSON.stringify({ id: item.id, invariant: item.invariant, purpose: item.purpose, ...evidence }, null, 2) + '\n');
      await writeFile(resolve(artifacts, 'request-protocol', item.id + '.md'),
        requestProtocolEvidenceMarkdown(item.id, evidence));
      report.runtimeReplay = 'same value positions, accepted inner protocol, independent terminals, freshness, and settled ownership';
    }
    reports.push(report);
    console.log(item.id + ': ' + report.outcome + ' (' + report.distinctStates + ' distinct states)');
  }
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const files = [...new Set(cases.flatMap((item) => [item.module, item.config]).concat([
    'experiments.json', 'toolchain.json', 'package.json', 'package-lock.json',
    'runtime/search-pipelines.mjs', 'runtime/replay-search-trace.mjs',
    'runtime/replay-lifecycle-trace.mjs', 'scripts/lifecycle-evidence.mjs',
    'runtime/replay-request-protocol.mjs', 'scripts/request-protocol-evidence.mjs',
    'scripts/check-models.mjs', 'scripts/setup-tlc.mjs',
  ]))];
  const inputs = await snapshotFiles(files);
  const headCommit = git.status === 0 ? git.stdout.trim() : null;
  const inputFilesMatchHead = headCommit !== null && Object.entries(inputs).every(([path, hash]) => {
    const committed = spawnSync('git', ['show', headCommit + ':' + path], { cwd: root, encoding: 'utf8' });
    return committed.status === 0 && digest(committed.stdout) === hash;
  });
  const summary = {
    status: 'completed', recordedAt: new Date().toISOString(),
    sourceCommit: inputFilesMatchHead ? headCommit : null, headCommit, inputFilesMatchHead,
    mode: 'TLC breadth-first exploration; finite domains and search horizon; no simulation',
    toolchain, node: process.version, inputs, reports,
  };
  await writeFile(resolve(artifacts, 'model-results.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkModels();
}
