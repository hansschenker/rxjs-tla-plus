import assert from 'node:assert/strict';
import { replayRequestProtocol } from '../runtime/replay-request-protocol.mjs';

const numericFields = [
  'now', 'latestRaw', 'pending', 'deadline', 'active', 'activeNextCount', 'lastId',
  'lastStartedId', 'lastStoppedId', 'lastOutputId', 'lastOutputIndex',
];
const stringDomains = {
  phase: ['external', 'timer', 'done'],
  sourceState: ['open', 'completed', 'errored', 'unsubscribed'],
  destinationState: ['open', 'completed', 'errored', 'cancelled'],
  lastEvent: ['Init', 'Query', 'Timer', 'InnerNext', 'InnerComplete', 'InnerError',
    'SourceComplete', 'SourceError', 'Cancel', 'EndExternal', 'EndTimer', 'Tick'],
  lastStopReason: ['none', 'complete', 'error', 'unsubscribe'],
  lastTerminal: ['none', 'C', 'E'],
};
const externalEvents = new Set([
  'Query', 'InnerNext', 'InnerComplete', 'InnerError', 'SourceComplete', 'SourceError', 'Cancel',
]);

// Decode only this experiment's observation vocabulary. This is not a general
// TLA+ interpreter and never reconstructs protocol expectations from RxJS code.
export const normalizeRequestProtocolState = (state, index) => {
  const normalized = { step: index + 1 };
  for (const name of numericFields) {
    assert.ok(Number.isSafeInteger(state[name]), 'Protocol state ' + (index + 1) + ': invalid ' + name);
    assert.ok(state[name] >= (name === 'deadline' ? -1 : 0), 'Protocol state: negative ' + name);
    normalized[name] = state[name];
  }
  for (const [name, domain] of Object.entries(stringDomains)) {
    assert.ok(domain.includes(state[name]), 'Protocol state ' + (index + 1) + ': unsupported ' + name);
    normalized[name] = state[name];
  }
  assert.equal(typeof state.badEmission, 'boolean', 'Protocol trace needs badEmission');
  normalized.badEmission = state.badEmission;
  assert.equal(normalized.lastOutputId === 0, normalized.lastOutputIndex === 0,
    'Protocol output ID and position must either both exist or both be absent');
  return normalized;
};

export const decodeRequestProtocolTrace = (output) => {
  const headers = [...output.matchAll(/^State (\d+):[^\n]*\n/gm)];
  const states = headers.map((header, index) => {
    const body = output.slice(header.index + header[0].length, headers[index + 1]?.index ?? output.length);
    const fields = {};
    for (const name of [...numericFields, ...Object.keys(stringDomains), 'badEmission']) {
      const prefix = '/\\ ' + name + ' = ';
      const line = body.split('\n').find(value => value.startsWith(prefix));
      assert.ok(line, 'Protocol trace is missing ' + name + ' at state ' + (index + 1));
      const value = line.slice(prefix.length);
      if (/^-?\d+$/.test(value)) fields[name] = Number(value);
      else if (value === 'TRUE' || value === 'FALSE') fields[name] = value === 'TRUE';
      else if (/^"[^"]*"$/.test(value)) fields[name] = JSON.parse(value);
      else throw new Error('Unsupported protocol scalar ' + name + ': ' + value);
    }
    return normalizeRequestProtocolState(fields, index);
  });
  assert.ok(states.length > 1 && states[0].lastEvent === 'Init', 'Expected a complete protocol counterexample');
  return states;
};

export const requestProtocolReplaySettings = (config) => {
  const policy = config.match(/\bPolicy\s*=\s*"([^"]+)"/)?.[1];
  const timerOrder = config.match(/\bTimerOrder\s*=\s*"([^"]+)"/)?.[1];
  const delay = Number(config.match(/\bDelay\s*=\s*(\d+)\b/)?.[1]);
  const maxValues = Number(config.match(/\bMaxValues\s*=\s*(\d+)\b/)?.[1]);
  const completeOnNext = config.match(/\bCompleteOnNext\s*=\s*(TRUE|FALSE)\b/)?.[1];
  assert.ok(['debounced', 'immediate'].includes(policy), 'Missing or unsupported protocol Policy');
  assert.ok(['external-first', 'timer-first'].includes(timerOrder), 'Missing or unsupported protocol TimerOrder');
  assert.ok(Number.isSafeInteger(delay) && delay > 0, 'Missing or unsupported protocol Delay');
  assert.ok(Number.isSafeInteger(maxValues) && maxValues > 0, 'Missing or unsupported protocol MaxValues');
  assert.equal(completeOnNext, 'FALSE', 'Only the correct request protocol may be replayed as correspondence evidence');
  return { policy, timerOrder, delay, maxValues };
};

export const replayRequestProtocolEvidence = (states, settings) => {
  assert.ok(states.length > 1 && states[0].lastEvent === 'Init');
  const counts = new Map();
  const acceptedInnerNotifications = [];
  const events = [];
  for (const state of states) {
    if (!externalEvents.has(state.lastEvent)) continue;
    const event = { type: state.lastEvent, at: state.now, id: state.lastId };
    if (state.lastEvent === 'InnerNext') {
      // Input ordinal is counted from accepted input events independently of
      // lastOutputIndex, so a missing/duplicated/reordered model output is visible.
      const index = (counts.get(state.lastId) ?? 0) + 1;
      counts.set(state.lastId, index);
      assert.ok(index <= settings.maxValues, 'Trace exceeds the configured request value bound');
      event.value = { requestId: state.lastId, position: index };
      acceptedInnerNotifications.push({ at: state.now, id: state.lastId, kind: 'N', index });
    } else if (state.lastEvent === 'InnerComplete' || state.lastEvent === 'InnerError') {
      acceptedInnerNotifications.push({
        at: state.now, id: state.lastId, kind: state.lastEvent === 'InnerComplete' ? 'C' : 'E',
      });
    }
    events.push(event);
  }
  const final = states.at(-1);
  const horizon = final.now;
  const runtime = replayRequestProtocol(events, { ...settings, horizon });
  const expected = {
    starts: states.filter(state => state.lastStartedId > 0)
      .map(state => ({ at: state.now, id: state.lastStartedId })),
    stops: states.filter(state => state.lastStoppedId > 0)
      .map(state => ({ at: state.now, id: state.lastStoppedId, reason: state.lastStopReason })),
    notifications: states.flatMap(state => [
      ...(state.lastOutputId > 0
        ? [{ at: state.now, kind: 'N', id: state.lastOutputId, index: state.lastOutputIndex }] : []),
      ...(state.lastTerminal !== 'none' ? [{ at: state.now, kind: state.lastTerminal }] : []),
    ]),
    acceptedInnerNotifications,
    requestNextCounts: states.filter(state => state.lastStartedId > 0)
      .map(state => ({ id: state.lastStartedId, nextCount: counts.get(state.lastStartedId) ?? 0 })),
    violations: states.filter(state => state.lastOutputId > 0 && state.lastOutputId !== state.latestRaw)
      .map(state => ({ at: state.now, resultId: state.lastOutputId, latestQueryId: state.latestRaw })),
    acceptedQueries: events.filter(event => event.type === 'Query').map(({ at, id }) => ({ at, id })),
    sourceState: final.sourceState,
    destinationState: final.destinationState,
    sourceOwned: final.sourceState === 'open',
    destinationClosed: final.destinationState !== 'open',
    latestQueryId: final.latestRaw,
    activeRequests: final.active > 0 ? [final.active] : [],
    activeNextCount: final.activeNextCount,
    badEmission: final.badEmission,
  };
  const observed = {
    starts: runtime.requests.map(({ start, id }) => ({ at: start, id })),
    stops: runtime.requests.filter(request => request.stop !== null)
      .map(({ stop, id, stopReason }) => ({ at: stop, id, reason: stopReason })),
    notifications: runtime.notifications.map(({ at, kind, id, index }) =>
      kind === 'N' ? { at, kind, id, index } : { at, kind }),
    acceptedInnerNotifications: runtime.acceptedInnerNotifications.map(({ at, id, kind, index }) =>
      kind === 'N' ? { at, id, kind, index } : { at, id, kind }),
    requestNextCounts: runtime.requests.map(({ id, nextCount }) => ({ id, nextCount })),
    violations: runtime.violations,
    acceptedQueries: runtime.acceptedQueries.map(({ at, id }) => ({ at, id })),
    sourceState: runtime.sourceState,
    destinationState: runtime.destinationState,
    sourceOwned: runtime.sourceOwned,
    destinationClosed: runtime.destinationClosed,
    latestQueryId: runtime.latestQueryId ?? 0,
    activeRequests: runtime.requests.filter(request => !request.closed).map(request => request.id),
    activeNextCount: runtime.requests.filter(request => !request.closed)
      .reduce((sum, request) => sum + request.nextCount, 0),
    badEmission: runtime.violations.length > 0,
  };
  assert.deepEqual(observed, expected,
    'Request protocol trace must match RxJS value positions, independent terminal events, and ownership');
  return { ...settings, horizon, states, events, expected, runtime };
};

export const requestProtocolEvidenceMarkdown = (id, evidence) => {
  const rows = evidence.states
    .filter(state => externalEvents.has(state.lastEvent) || state.lastEvent === 'Timer')
    .map(state => {
      const effects = [
        state.lastStoppedId > 0 ? 'stop ' + state.lastStoppedId + ' (' + state.lastStopReason + ')' : '',
        state.lastStartedId > 0 ? 'start ' + state.lastStartedId : '',
        state.lastOutputId > 0 ? 'next ' + state.lastOutputId + ':' + state.lastOutputIndex : '',
        state.lastTerminal !== 'none' ? state.lastTerminal : '',
      ].filter(Boolean).join('; ') || 'no output or request change';
      return '| ' + state.now + ' | ' + state.lastEvent + (state.lastId ? ' ' + state.lastId : '')
        + ' | ' + state.sourceState + ' / ' + state.destinationState
        + ' | ' + (state.active ? state.active + ' (' + state.activeNextCount + ' values)' : 'none')
        + ' | ' + effects + ' |';
    });
  return '# ' + id + ': actual checker trace replayed against RxJS\n\n'
    + 'Policy: ' + evidence.policy + '; timer order: ' + evidence.timerOrder
    + '; delay: ' + evidence.delay + '; maximum values per request: ' + evidence.maxValues + '.\n\n'
    + 'Value labels are request ID:position. Payloads are opaque. Rows omit phase/clock transitions; '
    + 'a reachability witness is an existence check, not an eventual-delivery guarantee.\n\n'
    + '| Frame | Event | Source / output state | Active request | Observations |\n'
    + '|---:|---|---|---|---|\n' + rows.join('\n') + '\n';
};
