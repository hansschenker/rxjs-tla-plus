import assert from 'node:assert/strict';
import { replayLifecycleTrace } from '../runtime/replay-lifecycle-trace.mjs';

const numericFields = [
  'now', 'latestRaw', 'pending', 'deadline', 'active', 'lastId',
  'lastStartedId', 'lastStoppedId', 'lastOutputId',
];
const stringFields = [
  'phase', 'sourceState', 'destinationState', 'lastEvent', 'lastStopReason', 'lastTerminal',
];
const externalEvents = new Set(['Query', 'Result', 'SourceComplete', 'SourceError', 'InnerError', 'Cancel']);

// This deliberately accepts only SearchLifecycle's observed scalar fields.
// It is shared by the text-TLC and structured tla-ts adapters, not by the model.
export const normalizeLifecycleState = (state, index) => {
  const normalized = { step: index + 1 };
  for (const field of numericFields) {
    assert.ok(Number.isSafeInteger(state[field]), `Lifecycle state ${index + 1}: invalid ${field}`);
    normalized[field] = state[field];
  }
  for (const field of stringFields) {
    assert.equal(typeof state[field], 'string', `Lifecycle state ${index + 1}: invalid ${field}`);
    normalized[field] = state[field];
  }
  assert.equal(typeof state.badEmission, 'boolean', 'Lifecycle trace needs badEmission');
  normalized.badEmission = state.badEmission;
  assert.ok(['none', 'C', 'E'].includes(normalized.lastTerminal));
  assert.ok(['none', 'complete', 'error', 'unsubscribe'].includes(normalized.lastStopReason));
  return normalized;
};

export const decodeLifecycleTrace = (output) => {
  const headers = [...output.matchAll(/^State (\d+):[^\n]*\n/gm)];
  const states = headers.map((header, index) => {
    const body = output.slice(header.index + header[0].length, headers[index + 1]?.index ?? output.length);
    const fields = {};
    for (const name of [...numericFields, ...stringFields, 'badEmission']) {
      const prefix = '/\\ ' + name + ' = ';
      const line = body.split('\n').find(value => value.startsWith(prefix));
      assert.ok(line, `Lifecycle trace is missing ${name} at state ${index + 1}`);
      const value = line.slice(prefix.length);
      if (/^-?\d+$/.test(value)) fields[name] = Number(value);
      else if (value === 'TRUE' || value === 'FALSE') fields[name] = value === 'TRUE';
      else if (/^"[^"]*"$/.test(value)) fields[name] = JSON.parse(value);
      else throw new Error('Unsupported lifecycle scalar ' + name + ': ' + value);
    }
    return normalizeLifecycleState(fields, index);
  });
  assert.ok(states.length > 1 && states[0].lastEvent === 'Init', 'Expected a complete lifecycle counterexample.');
  return states;
};

// Configurations in this experiment deliberately use literal assignments.
// Reject a new encoding rather than silently substituting a replay default.
export const lifecycleReplaySettings = (config) => {
  const policy = config.match(/\bPolicy\s*=\s*"([^"]+)"/)?.[1];
  const timerOrder = config.match(/\bTimerOrder\s*=\s*"([^"]+)"/)?.[1];
  const delayText = config.match(/\bDelay\s*=\s*(\d+)\b/)?.[1];
  assert.ok(['debounced', 'immediate'].includes(policy), 'Missing or unsupported lifecycle Policy');
  assert.ok(['external-first', 'timer-first'].includes(timerOrder), 'Missing or unsupported lifecycle TimerOrder');
  const delay = Number(delayText);
  assert.ok(Number.isSafeInteger(delay) && delay > 0, 'Missing or unsupported lifecycle Delay');
  return { policy, timerOrder, delay };
};

export const replayLifecycleEvidence = (states, settings) => {
  assert.ok(states.length > 1 && states[0].lastEvent === 'Init');
  const events = states.filter(state => externalEvents.has(state.lastEvent)).map(state => ({
    type: state.lastEvent, at: state.now, id: state.lastId,
  }));
  const horizon = states.at(-1).now;
  const runtime = replayLifecycleTrace(events, { ...settings, horizon });
  const expected = {
    starts: states.filter(state => state.lastStartedId > 0)
      .map(state => ({ at: state.now, id: state.lastStartedId })),
    stops: states.filter(state => state.lastStoppedId > 0)
      .map(state => ({ at: state.now, id: state.lastStoppedId, reason: state.lastStopReason })),
    notifications: states.flatMap(state => [
      ...(state.lastOutputId > 0 ? [{ at: state.now, kind: 'N', id: state.lastOutputId }] : []),
      ...(state.lastTerminal !== 'none' ? [{ at: state.now, kind: state.lastTerminal }] : []),
    ]),
    violations: states.filter(state => state.lastOutputId > 0 && state.lastOutputId !== state.latestRaw)
      .map(state => ({ at: state.now, resultId: state.lastOutputId, latestQueryId: state.latestRaw })),
    acceptedQueries: events.filter(event => event.type === 'Query').map(({ at, id }) => ({ at, id })),
    sourceState: states.at(-1).sourceState,
    destinationState: states.at(-1).destinationState,
    sourceOwned: states.at(-1).sourceState === 'open',
    destinationClosed: states.at(-1).destinationState !== 'open',
    latestQueryId: states.at(-1).latestRaw,
    activeRequests: states.at(-1).active > 0 ? [states.at(-1).active] : [],
  };
  const observed = {
    starts: runtime.requests.map(({ start, id }) => ({ at: start, id })),
    stops: runtime.requests.filter(request => request.stop !== null)
      .map(({ stop, id, stopReason }) => ({ at: stop, id, reason: stopReason })),
    notifications: runtime.notifications.map(({ at, kind, id }) => kind === 'N' ? { at, kind, id } : { at, kind }),
    violations: runtime.violations,
    acceptedQueries: runtime.acceptedQueries.map(({ at, id }) => ({ at, id })),
    sourceState: runtime.sourceState,
    destinationState: runtime.destinationState,
    sourceOwned: runtime.sourceOwned,
    destinationClosed: runtime.destinationClosed,
    latestQueryId: runtime.latestQueryId ?? 0,
    activeRequests: runtime.requests.filter(request => !request.closed).map(request => request.id),
  };
  assert.deepEqual(observed, expected, 'Lifecycle counterexample must match settled RxJS notifications and request ownership.');
  return { ...settings, horizon, states, events, expected, runtime };
};

export const lifecycleEvidenceMarkdown = (id, evidence) => {
  const rows = evidence.states.filter(state => externalEvents.has(state.lastEvent) || state.lastEvent === 'Timer')
    .map(state => {
      const effects = [
        state.lastStoppedId > 0 ? `stop ${state.lastStoppedId} (${state.lastStopReason})` : '',
        state.lastStartedId > 0 ? `start ${state.lastStartedId}` : '',
        state.lastOutputId > 0 ? `next ${state.lastOutputId}` : '',
        state.lastTerminal !== 'none' ? state.lastTerminal : '',
      ].filter(Boolean).join('; ') || 'no output or request change';
      return `| ${state.now} | ${state.lastEvent}${state.lastId ? ' ' + state.lastId : ''} | ${state.sourceState} / ${state.destinationState} | ${effects} |`;
    });
  return `# ${id}: actual checker trace replayed against RxJS\n\n`
    + `Policy: ${evidence.policy}; timer order: ${evidence.timerOrder}; delay: ${evidence.delay}.\n\n`
    + 'Rows show settled reactions, omitting phase/clock-only transitions. A witness violation may demonstrate reachable behavior rather than a failing application requirement.\n\n'
    + '| Frame | Event | Source / output state | Request and notification observations |\n|---:|---|---|---|\n'
    + rows.join('\n') + '\n';
};
