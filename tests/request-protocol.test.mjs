import assert from 'node:assert/strict';
import test from 'node:test';
import { replayRequestProtocol } from '../runtime/replay-request-protocol.mjs';

const policies = ['debounced', 'immediate'];
const orders = ['external-first', 'timer-first'];
const profiles = policies.flatMap((policy) => orders.map((timerOrder) => ({ policy, timerOrder })));
const request = (id, start, nextCount, stop = null, stopReason = null) => ({
  id, start, stop, stopReason, nextCount, closed: stop !== null,
});
const kinds = (replay) => replay.notifications.map(({ at, kind, id, index }) => ({
  at, kind, ...(kind === 'N' ? { id, index } : {}),
}));
const innerKinds = (replay) => replay.acceptedInnerNotifications.map(({ at, id, kind, index }) => ({
  at, id, kind, ...(kind === 'N' ? { index } : {}),
}));

test('InnerNext leaves the request open and forwards multiple values without completing', () => {
  for (const options of profiles) {
    const replay = replayRequestProtocol([
      { type: 'Query', at: 0, id: 1 },
      { type: 'InnerNext', at: 3, id: 1, value: 'first' },
      { type: 'InnerNext', at: 4, id: 1, value: 'second' },
    ], { ...options, horizon: 5 });
    assert.deepEqual(replay.outputs, [
      { at: 3, id: 1, index: 1, value: 'first' },
      { at: 4, id: 1, index: 2, value: 'second' },
    ]);
    assert.deepEqual(replay.requests, [request(1, 2, 2)]);
    assert.equal(replay.destinationState, 'open');
    assert.equal(replay.destinationClosed, false);
    assert.equal(replay.sourceOwned, true);
    assert.ok(replay.notifications.every(({ kind }) => kind === 'N'));
  }
});

test('source completion waits for independent inner completion after multiple values', () => {
  const prefix = [
    { type: 'Query', at: 0, id: 1 },
    { type: 'SourceComplete', at: 1 },
    { type: 'InnerNext', at: 3, id: 1, value: 'first' },
    { type: 'InnerNext', at: 4, id: 1, value: 'second' },
  ];
  for (const options of profiles) {
    const start = options.policy === 'debounced' ? 1 : 2;
    const waiting = replayRequestProtocol(prefix, options);
    assert.deepEqual(kinds(waiting), [
      { at: 3, kind: 'N', id: 1, index: 1 },
      { at: 4, kind: 'N', id: 1, index: 2 },
    ]);
    assert.equal(waiting.sourceState, 'completed');
    assert.equal(waiting.sourceOwned, false);
    assert.equal(waiting.destinationState, 'open');
    assert.equal(waiting.destinationClosed, false);
    assert.deepEqual(waiting.requests, [request(1, start, 2)]);
    const finished = replayRequestProtocol([...prefix, { type: 'InnerComplete', at: 5, id: 1 }], options);
    assert.deepEqual(kinds(finished), [...kinds(waiting), { at: 5, kind: 'C' }]);
    assert.deepEqual(finished.requests, [request(1, start, 2, 5, 'complete')]);
    assert.equal(finished.destinationState, 'completed');
    assert.equal(finished.destinationClosed, true);
    assert.deepEqual(innerKinds(finished), [
      { at: 3, id: 1, kind: 'N', index: 1 },
      { at: 4, id: 1, kind: 'N', index: 2 },
      { at: 5, id: 1, kind: 'C' },
    ]);
  }
});

test('an empty inner completion leaves an open source ready for a later query', () => {
  for (const options of profiles) {
    const empty = replayRequestProtocol([
      { type: 'Query', at: 0, id: 1 }, { type: 'InnerComplete', at: 3, id: 1 },
    ], options);
    assert.deepEqual(empty.requests, [request(1, 2, 0, 3, 'complete')]);
    assert.deepEqual(empty.notifications, []);
    assert.equal(empty.destinationState, 'open');
    assert.equal(empty.sourceOwned, true);
    const later = replayRequestProtocol([
      { type: 'Query', at: 0, id: 1 }, { type: 'InnerComplete', at: 3, id: 1 },
      { type: 'Query', at: 4, id: 2 }, { type: 'InnerNext', at: 7, id: 2 },
      { type: 'InnerComplete', at: 8, id: 2 },
    ], options);
    assert.deepEqual(later.requests, [request(1, 2, 0, 3, 'complete'), request(2, 6, 1, 8, 'complete')]);
    assert.deepEqual(kinds(later), [{ at: 7, kind: 'N', id: 2, index: 1 }]);
    assert.equal(later.destinationState, 'open');
  }
});

test('an empty request completes a completed source without inventing a value', () => {
  for (const options of profiles) {
    const replay = replayRequestProtocol([
      { type: 'Query', at: 0, id: 1 }, { type: 'SourceComplete', at: 1 },
      { type: 'InnerComplete', at: 3, id: 1 },
    ], options);
    assert.deepEqual(replay.requests, [request(1, options.policy === 'debounced' ? 1 : 2, 0, 3, 'complete')]);
    assert.deepEqual(replay.outputs, []);
    assert.deepEqual(kinds(replay), [{ at: 3, kind: 'C' }]);
    assert.deepEqual(innerKinds(replay), [{ at: 3, id: 1, kind: 'C' }]);
    assert.equal(replay.destinationClosed, true);
    assert.equal(replay.sourceOwned, false);
  }
});

test('source completion after an independently completed request closes immediately', () => {
  for (const options of profiles) {
    const replay = replayRequestProtocol([
      { type: 'Query', at: 0, id: 1 }, { type: 'InnerNext', at: 3, id: 1 },
      { type: 'InnerComplete', at: 4, id: 1 }, { type: 'SourceComplete', at: 5 },
    ], options);
    assert.deepEqual(replay.requests, [request(1, 2, 1, 4, 'complete')]);
    assert.deepEqual(kinds(replay), [{ at: 3, kind: 'N', id: 1, index: 1 }, { at: 5, kind: 'C' }]);
    assert.deepEqual(replay.sourceLifetime, { start: 0, stop: 5, stopReason: 'complete' });
  }
});

test('an inner error can occur before values or after several values and releases the source', () => {
  for (const options of profiles) {
    for (const count of [0, 2]) {
      const nexts = Array.from({ length: count }, (_, index) => ({ type: 'InnerNext', at: 3, id: 1, value: index }));
      const replay = replayRequestProtocol([
        { type: 'Query', at: 0, id: 1 }, ...nexts,
        { type: 'InnerError', at: 4, id: 1, error: new Error('request failed after ' + count) },
        { type: 'InnerComplete', at: 5, id: 1 }, { type: 'InnerNext', at: 5, id: 1 },
      ], options);
      assert.deepEqual(replay.requests, [request(1, 2, count, 4, 'error')]);
      assert.deepEqual(kinds(replay), [
        ...nexts.map((_, index) => ({ at: 3, kind: 'N', id: 1, index: index + 1 })),
        { at: 4, kind: 'E' },
      ]);
      assert.equal(replay.notifications.at(-1).error, 'request failed after ' + count);
      assert.equal(replay.sourceState, 'unsubscribed');
      assert.equal(replay.destinationState, 'errored');
      assert.equal(replay.sourceOwned, false);
      assert.equal(replay.acceptedInnerNotifications.length, count + 1);
    }
  }
});

test('source completion does not turn a later inner error into successful completion', () => {
  for (const options of profiles) {
    const replay = replayRequestProtocol([
      { type: 'Query', at: 0, id: 1 }, { type: 'SourceComplete', at: 1 },
      { type: 'InnerNext', at: 3, id: 1 }, { type: 'InnerError', at: 4, id: 1 },
    ], options);
    assert.deepEqual(kinds(replay), [{ at: 3, kind: 'N', id: 1, index: 1 }, { at: 4, kind: 'E' }]);
    assert.equal(replay.sourceState, 'completed');
    assert.equal(replay.destinationState, 'errored');
    assert.deepEqual(replay.requests, [request(1, options.policy === 'debounced' ? 1 : 2, 1, 4, 'error')]);
  }
});

test('source error after a value closes the request and suppresses its later protocol attempts', () => {
  for (const options of profiles) {
    const replay = replayRequestProtocol([
      { type: 'Query', at: 0, id: 1 }, { type: 'InnerNext', at: 3, id: 1 },
      { type: 'SourceError', at: 4, error: 'source stopped' },
      { type: 'InnerNext', at: 5, id: 1 }, { type: 'InnerComplete', at: 5, id: 1 },
      { type: 'InnerError', at: 5, id: 1 }, { type: 'Query', at: 5, id: 2 },
    ], options);
    assert.deepEqual(replay.requests, [request(1, 2, 1, 4, 'unsubscribe')]);
    assert.deepEqual(kinds(replay), [{ at: 3, kind: 'N', id: 1, index: 1 }, { at: 4, kind: 'E' }]);
    assert.deepEqual(innerKinds(replay), [{ at: 3, id: 1, kind: 'N', index: 1 }]);
    assert.equal(replay.sourceState, 'errored');
    assert.equal(replay.destinationState, 'errored');
    assert.equal(replay.latestQueryId, 1);
  }
});

test('cancellation between values stops ownership without adding a terminal notification', () => {
  for (const options of profiles) {
    const replay = replayRequestProtocol([
      { type: 'Query', at: 0, id: 1 }, { type: 'InnerNext', at: 3, id: 1 },
      { type: 'Cancel', at: 4 },
      { type: 'InnerNext', at: 5, id: 1 }, { type: 'InnerComplete', at: 5, id: 1 },
      { type: 'InnerError', at: 5, id: 1 }, { type: 'Query', at: 5, id: 2 },
      { type: 'SourceComplete', at: 5 }, { type: 'SourceError', at: 5 },
    ], options);
    assert.deepEqual(replay.requests, [request(1, 2, 1, 4, 'unsubscribe')]);
    assert.deepEqual(kinds(replay), [{ at: 3, kind: 'N', id: 1, index: 1 }]);
    assert.equal(replay.destinationState, 'cancelled');
    assert.equal(replay.destinationClosed, true);
    assert.equal(replay.sourceOwned, false);
    assert.equal(replay.latestQueryId, 1);
    assert.equal(replay.acceptedInnerNotifications.length, 1);
  }
});

test('cancelling a pending wait prevents all request protocol activity', () => {
  for (const options of profiles) {
    const replay = replayRequestProtocol([
      { type: 'Query', at: 0, id: 1 }, { type: 'Cancel', at: 1 },
      { type: 'InnerNext', at: 3, id: 1 }, { type: 'InnerComplete', at: 3, id: 1 },
      { type: 'InnerError', at: 3, id: 1 },
    ], options);
    assert.deepEqual(replay.requests, []);
    assert.deepEqual(replay.notifications, []);
    assert.deepEqual(replay.acceptedInnerNotifications, []);
    assert.equal(replay.destinationState, 'cancelled');
  }
});

test('immediate selection cancels between values and restarts notification indexing for the new request', () => {
  for (const timerOrder of orders) {
    const replay = replayRequestProtocol([
      { type: 'Query', at: 0, id: 1 }, { type: 'InnerNext', at: 3, id: 1 },
      { type: 'Query', at: 4, id: 2 },
      { type: 'InnerNext', at: 4, id: 1 }, { type: 'InnerComplete', at: 4, id: 1 },
      { type: 'InnerError', at: 4, id: 1 },
      { type: 'InnerNext', at: 7, id: 2 }, { type: 'InnerNext', at: 7, id: 2 },
      { type: 'InnerComplete', at: 8, id: 2 },
    ], { policy: 'immediate', timerOrder });
    assert.deepEqual(replay.requests, [request(1, 2, 1, 4, 'unsubscribe'), request(2, 6, 2, 8, 'complete')]);
    assert.deepEqual(kinds(replay), [
      { at: 3, kind: 'N', id: 1, index: 1 },
      { at: 7, kind: 'N', id: 2, index: 1 },
      { at: 7, kind: 'N', id: 2, index: 2 },
    ]);
    assert.deepEqual(replay.violations, []);
    for (const suffix of ['Next', 'Complete', 'Error']) {
      assert.ok(replay.log.some(({ type, id }) => type === 'IgnoredInner' + suffix && id === 1));
    }
  }
});

test('debounced selection can deliver another old value after newer raw input', () => {
  for (const timerOrder of orders) {
    const replay = replayRequestProtocol([
      { type: 'Query', at: 0, id: 1 }, { type: 'InnerNext', at: 3, id: 1 },
      { type: 'Query', at: 4, id: 2 }, { type: 'InnerNext', at: 4, id: 1 },
      { type: 'InnerComplete', at: 4, id: 1 },
      { type: 'InnerNext', at: 7, id: 2 }, { type: 'InnerComplete', at: 8, id: 2 },
    ], { policy: 'debounced', timerOrder });
    assert.deepEqual(replay.requests, [request(1, 2, 2, 4, 'complete'), request(2, 6, 1, 8, 'complete')]);
    assert.deepEqual(kinds(replay), [
      { at: 3, kind: 'N', id: 1, index: 1 },
      { at: 4, kind: 'N', id: 1, index: 2 },
      { at: 7, kind: 'N', id: 2, index: 1 },
    ]);
    assert.deepEqual(replay.violations, [{ at: 4, resultId: 1, latestQueryId: 2 }]);
    assert.equal(replay.destinationState, 'open');
  }
});

test('completion flush switches away from a partly delivered request before the new empty request completes', () => {
  for (const timerOrder of orders) {
    const replay = replayRequestProtocol([
      { type: 'Query', at: 0, id: 1 }, { type: 'InnerNext', at: 3, id: 1 },
      { type: 'Query', at: 4, id: 2 }, { type: 'SourceComplete', at: 4 },
      { type: 'InnerNext', at: 5, id: 1 }, { type: 'InnerComplete', at: 5, id: 1 },
      { type: 'InnerComplete', at: 5, id: 2 },
    ], { policy: 'debounced', timerOrder });
    assert.deepEqual(replay.requests, [request(1, 2, 1, 4, 'unsubscribe'), request(2, 4, 0, 5, 'complete')]);
    assert.deepEqual(kinds(replay), [{ at: 3, kind: 'N', id: 1, index: 1 }, { at: 5, kind: 'C' }]);
    assert.deepEqual(replay.violations, []);
    assert.equal(replay.destinationClosed, true);
  }
});

test('same-frame next and complete follow their supplied order as independent notifications', () => {
  for (const options of profiles) {
    const prefix = [{ type: 'Query', at: 0, id: 1 }, { type: 'SourceComplete', at: 1 }];
    const next = { type: 'InnerNext', at: 3, id: 1 };
    const complete = { type: 'InnerComplete', at: 3, id: 1 };
    const before = replayRequestProtocol([...prefix, next, complete], options);
    const after = replayRequestProtocol([...prefix, complete, next], options);
    assert.deepEqual(kinds(before), [{ at: 3, kind: 'N', id: 1, index: 1 }, { at: 3, kind: 'C' }]);
    assert.deepEqual(kinds(after), [{ at: 3, kind: 'C' }]);
    assert.equal(before.requests[0].nextCount, 1);
    assert.equal(after.requests[0].nextCount, 0);
    assert.equal(before.destinationClosed, true);
    assert.equal(after.destinationClosed, true);
  }
});

test('same-frame next and error follow their supplied order and allow only one terminal', () => {
  for (const options of profiles) {
    const query = { type: 'Query', at: 0, id: 1 };
    const next = { type: 'InnerNext', at: 3, id: 1 };
    const error = { type: 'InnerError', at: 3, id: 1 };
    const complete = { type: 'InnerComplete', at: 3, id: 1 };
    const before = replayRequestProtocol([query, next, error, complete, error], options);
    const after = replayRequestProtocol([query, error, next, complete, error], options);
    assert.deepEqual(kinds(before), [{ at: 3, kind: 'N', id: 1, index: 1 }, { at: 3, kind: 'E' }]);
    assert.deepEqual(kinds(after), [{ at: 3, kind: 'E' }]);
    assert.equal(before.acceptedInnerNotifications.length, 2);
    assert.equal(after.acceptedInnerNotifications.length, 1);
    assert.equal(before.requests[0].stopReason, 'error');
    assert.equal(after.requests[0].stopReason, 'error');
  }
});

test('timer-boundary order determines whether request notifications occur before subscription', () => {
  const trace = [
    { type: 'Query', at: 0, id: 1 },
    { type: 'InnerNext', at: 2, id: 1 }, { type: 'InnerComplete', at: 2, id: 1 },
  ];
  for (const policy of policies) {
    const external = replayRequestProtocol(trace, { policy, timerOrder: 'external-first' });
    const timer = replayRequestProtocol(trace, { policy, timerOrder: 'timer-first' });
    assert.deepEqual(external.requests, [request(1, 2, 0)]);
    assert.deepEqual(external.acceptedInnerNotifications, []);
    assert.deepEqual(external.notifications, []);
    assert.deepEqual(timer.requests, [request(1, 2, 1, 2, 'complete')]);
    assert.deepEqual(kinds(timer), [{ at: 2, kind: 'N', id: 1, index: 1 }]);
    assert.equal(timer.destinationState, 'open');
  }
});

test('a query at the timer boundary can cancel a just-started request before its first value', () => {
  const trace = [
    { type: 'Query', at: 0, id: 1 }, { type: 'Query', at: 2, id: 2 },
    { type: 'InnerNext', at: 2, id: 1 },
  ];
  for (const policy of policies) {
    const external = replayRequestProtocol(trace, { policy, timerOrder: 'external-first' });
    const timer = replayRequestProtocol(trace, { policy, timerOrder: 'timer-first' });
    assert.deepEqual(external.requests, []);
    assert.deepEqual(external.notifications, []);
    if (policy === 'immediate') {
      assert.deepEqual(timer.requests, [request(1, 2, 0, 2, 'unsubscribe')]);
      assert.deepEqual(timer.notifications, []);
    } else {
      assert.deepEqual(timer.requests, [request(1, 2, 1)]);
      assert.deepEqual(kinds(timer), [{ at: 2, kind: 'N', id: 1, index: 1 }]);
      assert.deepEqual(timer.violations, [{ at: 2, resultId: 1, latestQueryId: 2 }]);
    }
  }
});

test('opaque repeated payloads retain identity and explicit null and undefined remain values', () => {
  const shared = Object.freeze({ result: ['same', 'object'] });
  const values = [shared, shared, null, undefined];
  for (const options of profiles) {
    const replay = replayRequestProtocol([
      { type: 'Query', at: 0, id: 1 },
      ...values.map(value => ({ type: 'InnerNext', at: 3, id: 1, value })),
      { type: 'InnerComplete', at: 4, id: 1 },
    ], options);
    assert.deepEqual(replay.outputs.map(({ index }) => index), [1, 2, 3, 4]);
    for (let index = 0; index < values.length; index++) {
      assert.equal(replay.outputs[index].value, values[index]);
      assert.equal(replay.acceptedInnerNotifications[index].value, values[index]);
      assert.equal(Object.hasOwn(replay.outputs[index], 'value'), true);
    }
    assert.deepEqual(replay.requests, [request(1, 2, 4, 4, 'complete')]);
    assert.ok(replay.notifications.every(({ kind }) => kind === 'N'));
  }
});

test('an empty source completes with no requests or inner notifications', () => {
  for (const options of profiles) {
    const replay = replayRequestProtocol([{ type: 'SourceComplete', at: 0 }], options);
    assert.deepEqual(kinds(replay), [{ at: 0, kind: 'C' }]);
    assert.deepEqual(replay.requests, []);
    assert.deepEqual(replay.acceptedInnerNotifications, []);
    assert.equal(replay.sourceOwned, false);
    assert.equal(replay.destinationClosed, true);
  }
});

test('request protocol replay rejects legacy bundled results and unsupported inputs', () => {
  assert.throws(() => replayRequestProtocol([{ type: 'Result', at: 0, id: 1 }]), /Unknown request protocol event/);
  assert.throws(() => replayRequestProtocol([{ type: 'InnerComplete', at: 0 }]), /positive safe integer notification id/);
  assert.throws(() => replayRequestProtocol([{ type: 'Query', at: 0, id: 1 }, { type: 'Query', at: 1, id: 1 }]), /distinct notification id/);
  assert.throws(() => replayRequestProtocol([{ type: 'Query', at: 0.5, id: 1 }]), /safe nonnegative integers/);
  assert.throws(() => replayRequestProtocol([{ type: 'Advance', to: 3 }, { type: 'Advance', to: 2 }]), /nondecreasing order/);
  assert.throws(() => replayRequestProtocol([{ type: 'SourceComplete', at: 2 }], { horizon: 1 }), /including every external event/);
  assert.throws(() => replayRequestProtocol([], { delay: 0 }), /positive safe integer/);
  assert.throws(() => replayRequestProtocol([], { policy: 'unknown' }), /Unknown search policy/);
  assert.throws(() => replayRequestProtocol([], { timerOrder: 'mixed' }), /Unknown timer order/);
});
