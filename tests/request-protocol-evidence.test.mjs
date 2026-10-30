import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeRequestProtocolState, decodeRequestProtocolTrace,
  requestProtocolReplaySettings, replayRequestProtocolEvidence,
} from '../scripts/request-protocol-evidence.mjs';

const initial = {
  now: 0, phase: 'timer', latestRaw: 0, pending: 0, deadline: -1,
  active: 0, activeNextCount: 0, sourceState: 'open', destinationState: 'open',
  lastEvent: 'Init', lastId: 0, lastStartedId: 0, lastStoppedId: 0,
  lastStopReason: 'none', lastOutputId: 0, lastOutputIndex: 0,
  lastTerminal: 'none', badEmission: false,
};
const settings = { policy: 'immediate', timerOrder: 'timer-first', delay: 2, maxValues: 2 };
const nextAfterCompletion = () => [
  initial,
  { ...initial, phase: 'external', latestRaw: 1, pending: 1, deadline: 2, lastEvent: 'Query', lastId: 1 },
  { ...initial, phase: 'external', latestRaw: 1, pending: 1, deadline: 2,
    sourceState: 'completed', lastEvent: 'SourceComplete' },
  { ...initial, now: 2, latestRaw: 1, active: 1, sourceState: 'completed',
    lastEvent: 'Timer', lastId: 1, lastStartedId: 1 },
  { ...initial, now: 2, phase: 'external', latestRaw: 1, active: 1, activeNextCount: 1,
    sourceState: 'completed', lastEvent: 'InnerNext', lastId: 1, lastOutputId: 1, lastOutputIndex: 1 },
].map(normalizeRequestProtocolState);

test('protocol trace adapters require value position and ownership observations', () => {
  const missing = { ...initial };
  delete missing.lastOutputIndex;
  assert.throws(() => normalizeRequestProtocolState(missing, 0), /lastOutputIndex/);
  assert.throws(() => normalizeRequestProtocolState({ ...initial, lastEvent: 'Result' }, 0), /lastEvent/);
  assert.throws(() => decodeRequestProtocolTrace('State 1: <Initial predicate>\n/\\ now = 0\n'), /missing/);
});

test('protocol replay settings reject missing bounds, unknown order and a mutant protocol', () => {
  const config = 'Policy = "immediate"\nTimerOrder = "timer-first"\nDelay = 2\nMaxValues = 2\nCompleteOnNext = FALSE';
  assert.deepEqual(requestProtocolReplaySettings(config), settings);
  assert.throws(() => requestProtocolReplaySettings(config.replace('MaxValues = 2', '')), /MaxValues/);
  assert.throws(() => requestProtocolReplaySettings(config.replace('timer-first', 'arbitrary')), /TimerOrder/);
  assert.throws(() => requestProtocolReplaySettings(config.replace('FALSE', 'TRUE')), /correct request protocol/);
});

test('protocol correspondence keeps a request open after next from a completed source', () => {
  const evidence = replayRequestProtocolEvidence(nextAfterCompletion(), settings);
  assert.equal(evidence.runtime.destinationClosed, false);
  assert.equal(evidence.runtime.requests[0].nextCount, 1);
  assert.equal(evidence.runtime.requests[0].closed, false);
});

test('protocol correspondence rejects a model that implicitly completes on next', () => {
  const states = nextAfterCompletion();
  states[states.length - 1] = {
    ...states.at(-1), active: 0, activeNextCount: 0, destinationState: 'completed',
    lastStoppedId: 1, lastStopReason: 'complete', lastTerminal: 'C',
  };
  assert.throws(() => replayRequestProtocolEvidence(states, settings), /Request protocol trace must match/);
});

test('protocol correspondence rejects duplicated output positions', () => {
  const states = nextAfterCompletion();
  states.push({ ...states.at(-1), step: 6, activeNextCount: 2, lastOutputIndex: 1 });
  assert.throws(() => replayRequestProtocolEvidence(states, settings), /Request protocol trace must match/);
});
