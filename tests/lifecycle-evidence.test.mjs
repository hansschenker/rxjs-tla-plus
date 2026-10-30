import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeLifecycleState, decodeLifecycleTrace, lifecycleReplaySettings, replayLifecycleEvidence,
} from '../scripts/lifecycle-evidence.mjs';

const initial = {
  now: 0, phase: 'external', latestRaw: 0, pending: 0, deadline: -1, active: 0,
  sourceState: 'open', destinationState: 'open', lastEvent: 'Init', lastId: 0,
  lastStartedId: 0, lastStoppedId: 0, lastStopReason: 'none', lastOutputId: 0,
  lastTerminal: 'none', badEmission: false,
};

test('lifecycle trace adapters reject missing ownership observations', () => {
  const missing = { ...initial };
  delete missing.lastStoppedId;
  assert.throws(() => normalizeLifecycleState(missing, 0), /lastStoppedId/);
  assert.throws(() => decodeLifecycleTrace('State 1: <Initial predicate>\n/\\ now = 0\n'), /missing/);
});

test('lifecycle replay rejects an unknown scheduler profile instead of assuming one', () => {
  assert.throws(() => lifecycleReplaySettings('Policy = "immediate"\nDelay = 2'), /TimerOrder/);
  assert.throws(() => lifecycleReplaySettings('Policy = "immediate"\nTimerOrder = "any"\nDelay = 2'), /TimerOrder/);
  assert.throws(() => lifecycleReplaySettings('Policy = "immediate"\nTimerOrder = "external-first"\nDelay = 0'), /Delay/);
});

test('the correspondence gate rejects replaying a completion-flush trace with the waiting policy', () => {
  // A hand-specified semantic fixture: query at 0, source completion at 1.
  // The debounced policy starts the request at completion, before deadline 2.
  const waiting = { ...initial, latestRaw: 1, pending: 1, deadline: 2 };
  const states = [
    initial,
    { ...waiting, lastEvent: 'Query', lastId: 1 },
    { ...waiting, now: 1, lastEvent: 'Tick' },
    { ...waiting, now: 1, pending: 0, deadline: -1, active: 1,
      sourceState: 'completed', lastEvent: 'SourceComplete', lastStartedId: 1 },
  ].map(normalizeLifecycleState);
  const settings = { policy: 'debounced', timerOrder: 'external-first', delay: 2 };
  const evidence = replayLifecycleEvidence(states, settings);
  assert.deepEqual(evidence.runtime.requests, [
    { id: 1, start: 1, stop: null, stopReason: null, closed: false },
  ]);
  assert.throws(() => replayLifecycleEvidence(states, { ...settings, policy: 'immediate' }),
    /Lifecycle counterexample must match/);
});
