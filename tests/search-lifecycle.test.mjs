import assert from 'node:assert/strict';
import test from 'node:test';
import { replayLifecycleTrace } from '../runtime/replay-lifecycle-trace.mjs';

const policies = ['debounced', 'immediate'];
const orders = ['external-first', 'timer-first'];
const profiles = policies.flatMap((policy) => orders.map((timerOrder) => ({ policy, timerOrder })));
const request = (id, start, stop = null, stopReason = null) => ({ id, start, stop, stopReason, closed: stop !== null });
const kinds = (replay) => replay.notifications.map(({ at, kind, id }) => ({ at, kind, ...(id === undefined ? {} : { id }) }));

test('lifecycle replay completes an empty source without creating work', () => {
  for (const options of profiles) {
    const replay = replayLifecycleTrace([{ type: 'SourceComplete', at: 0 }], options);
    assert.deepEqual(kinds(replay), [{ at: 0, kind: 'C' }]);
    assert.deepEqual(replay.requests, []);
    assert.equal(replay.sourceState, 'completed');
    assert.equal(replay.destinationState, 'completed');
    assert.equal(replay.sourceOwned, false);
    assert.equal(replay.destinationClosed, true);
  }
});

test('completion flushes the pending debounced value but preserves the immediate timer', () => {
  const trace = [
    { type: 'Query', at: 0, id: 1 },
    { type: 'SourceComplete', at: 1 },
    { type: 'Result', at: 3, id: 1 },
  ];
  for (const options of profiles) {
    const replay = replayLifecycleTrace(trace, options);
    assert.deepEqual(replay.requests, [request(1, options.policy === 'debounced' ? 1 : 2, 3, 'complete')]);
    assert.deepEqual(kinds(replay), [{ at: 3, kind: 'N', id: 1 }, { at: 3, kind: 'C' }]);
    assert.deepEqual(replay.sourceLifetime, { start: 0, stop: 1, stopReason: 'complete' });
    assert.equal(replay.destinationState, 'completed');
  }
});

test('completion while a request is active waits for that request to finish', () => {
  for (const options of profiles) {
    const waiting = replayLifecycleTrace([
      { type: 'Query', at: 0, id: 1 }, { type: 'SourceComplete', at: 3 },
    ], { ...options, horizon: 4 });
    assert.equal(waiting.sourceState, 'completed');
    assert.equal(waiting.destinationState, 'open');
    assert.deepEqual(waiting.requests, [request(1, 2)]);
    assert.deepEqual(waiting.notifications, []);
    const finished = replayLifecycleTrace([
      { type: 'Query', at: 0, id: 1 }, { type: 'SourceComplete', at: 3 },
      { type: 'Result', at: 4, id: 1 },
    ], options);
    assert.deepEqual(kinds(finished), [{ at: 4, kind: 'N', id: 1 }, { at: 4, kind: 'C' }]);
    assert.deepEqual(finished.requests, [request(1, 2, 4, 'complete')]);
  }
});

test('a completion flush replaces an old baseline request with the latest pending query', () => {
  const replay = replayLifecycleTrace([
    { type: 'Query', at: 0, id: 1 },
    { type: 'Query', at: 3, id: 2 },
    { type: 'SourceComplete', at: 3 },
    { type: 'Result', at: 4, id: 1 },
    { type: 'Result', at: 4, id: 2 },
  ], { policy: 'debounced' });
  assert.deepEqual(replay.requests, [request(1, 2, 3, 'unsubscribe'), request(2, 3, 4, 'complete')]);
  assert.deepEqual(kinds(replay), [{ at: 4, kind: 'N', id: 2 }, { at: 4, kind: 'C' }]);
  assert.deepEqual(replay.violations, []);
});

test('source error discards pending input without a completion flush', () => {
  for (const options of profiles) {
    const replay = replayLifecycleTrace([
      { type: 'Query', at: 0, id: 1 },
      { type: 'SourceError', at: 1, error: new Error('source broke') },
      { type: 'Advance', to: 5 },
    ], options);
    assert.deepEqual(replay.requests, []);
    assert.deepEqual(replay.notifications, [{ at: 1, kind: 'E', error: 'source broke' }]);
    assert.equal(replay.sourceState, 'errored');
    assert.equal(replay.destinationState, 'errored');
    assert.equal(replay.sourceOwned, false);
  }
});

test('source error tears down an active request and suppresses its later result', () => {
  for (const options of profiles) {
    const replay = replayLifecycleTrace([
      { type: 'Query', at: 0, id: 1 }, { type: 'SourceError', at: 3 },
      { type: 'Result', at: 4, id: 1 },
    ], options);
    assert.deepEqual(replay.requests, [request(1, 2, 3, 'unsubscribe')]);
    assert.deepEqual(kinds(replay), [{ at: 3, kind: 'E' }]);
    assert.deepEqual(replay.outputs, []);
  }
});

test('an active inner error terminates both pipelines and releases their source', () => {
  for (const options of profiles) {
    const replay = replayLifecycleTrace([
      { type: 'Query', at: 0, id: 1 },
      { type: 'InnerError', at: 3, id: 1, error: new Error('request broke') },
    ], options);
    assert.deepEqual(replay.requests, [request(1, 2, 3, 'error')]);
    assert.deepEqual(replay.notifications, [{ at: 3, kind: 'E', error: 'request broke' }]);
    assert.equal(replay.sourceState, 'unsubscribed');
    assert.equal(replay.destinationState, 'errored');
    assert.equal(replay.sourceOwned, false);
  }
});

test('an old inner error terminates a baseline pending wait but is ignored after immediate cancellation', () => {
  const trace = [
    { type: 'Query', at: 0, id: 1 }, { type: 'Query', at: 3, id: 2 },
    { type: 'InnerError', at: 4, id: 1 }, { type: 'Result', at: 6, id: 2 },
  ];
  const baseline = replayLifecycleTrace(trace, { policy: 'debounced' });
  assert.deepEqual(baseline.requests, [request(1, 2, 4, 'error')]);
  assert.deepEqual(kinds(baseline), [{ at: 4, kind: 'E' }]);
  assert.equal(baseline.sourceState, 'unsubscribed');
  const immediate = replayLifecycleTrace(trace, { policy: 'immediate' });
  assert.deepEqual(immediate.requests, [request(1, 2, 3, 'unsubscribe'), request(2, 5, 6, 'complete')]);
  assert.deepEqual(kinds(immediate), [{ at: 6, kind: 'N', id: 2 }]);
  assert.equal(immediate.destinationState, 'open');
  assert.ok(immediate.log.some(({ type, id }) => type === 'IgnoredInnerError' && id === 1));
});

test('cancellation releases waiting or active work without a terminal notification', () => {
  for (const options of profiles) {
    for (const cancelAt of [1, 3]) {
      const replay = replayLifecycleTrace([
        { type: 'Query', at: 0, id: 1 }, { type: 'Cancel', at: cancelAt },
        { type: 'Result', at: 4, id: 1 }, { type: 'Query', at: 4, id: 2 },
        { type: 'Advance', to: 7 },
      ], options);
      assert.deepEqual(replay.requests, cancelAt === 1 ? [] : [request(1, 2, 3, 'unsubscribe')]);
      assert.deepEqual(replay.notifications, []);
      assert.equal(replay.sourceState, 'unsubscribed');
      assert.equal(replay.destinationState, 'cancelled');
      assert.equal(replay.latestQueryId, 1);
      assert.deepEqual(replay.acceptedQueries, [{ at: 0, id: 1 }]);
    }
  }
});

test('late source and request attempts cannot alter the terminal outcome or freshness oracle', () => {
  for (const options of profiles) {
    const replay = replayLifecycleTrace([
      { type: 'Query', at: 0, id: 1 }, { type: 'SourceComplete', at: 1 },
      { type: 'Query', at: 2, id: 2 }, { type: 'SourceError', at: 2 },
      { type: 'Result', at: 3, id: 1 }, { type: 'InnerError', at: 4, id: 1 },
      { type: 'SourceComplete', at: 4 }, { type: 'Cancel', at: 4 },
    ], options);
    assert.equal(replay.latestQueryId, 1);
    assert.deepEqual(replay.violations, []);
    assert.deepEqual(kinds(replay), [{ at: 3, kind: 'N', id: 1 }, { at: 3, kind: 'C' }]);
    assert.equal(replay.sourceState, 'completed');
    assert.equal(replay.destinationState, 'completed');
    assert.deepEqual(replay.acceptedQueries, [{ at: 0, id: 1 }]);
  }
});

test('timer boundary ordering controls whether the superseded request starts at all', () => {
  const trace = [{ type: 'Query', at: 0, id: 1 }, { type: 'Query', at: 2, id: 2 }];
  for (const policy of policies) {
    const external = replayLifecycleTrace(trace, { policy, timerOrder: 'external-first', horizon: 4 });
    assert.deepEqual(external.requests, [request(2, 4)]);
    const timer = replayLifecycleTrace(trace, { policy, timerOrder: 'timer-first', horizon: 4 });
    assert.deepEqual(timer.requests, [request(1, 2, policy === 'immediate' ? 2 : 4, 'unsubscribe'), request(2, 4)]);
    assert.deepEqual(timer.acceptedQueries, external.acceptedQueries);
    assert.deepEqual(timer.notifications, []);
  }
});

test('error at a timer deadline either prevents a request or tears down a transient request', () => {
  const trace = [{ type: 'Query', at: 0, id: 1 }, { type: 'SourceError', at: 2 }];
  for (const policy of policies) {
    const external = replayLifecycleTrace(trace, { policy, timerOrder: 'external-first' });
    const timer = replayLifecycleTrace(trace, { policy, timerOrder: 'timer-first' });
    assert.deepEqual(external.requests, []);
    assert.deepEqual(timer.requests, [request(1, 2, 2, 'unsubscribe')]);
    assert.deepEqual(kinds(timer), [{ at: 2, kind: 'E' }]);
    assert.deepEqual(timer.notifications, external.notifications);
  }
});

test('the ordering profile also holds after debounceTime rearms an early timer wakeup', () => {
  const trace = [
    { type: 'Query', at: 0, id: 1 }, { type: 'Query', at: 1, id: 2 },
    { type: 'Query', at: 3, id: 3 },
  ];
  for (const policy of policies) {
    const external = replayLifecycleTrace(trace, { policy, timerOrder: 'external-first', horizon: 5 });
    assert.deepEqual(external.requests, [request(3, 5)]);
    const timer = replayLifecycleTrace(trace, { policy, timerOrder: 'timer-first', horizon: 5 });
    assert.deepEqual(timer.requests, [request(2, 3, policy === 'immediate' ? 3 : 5, 'unsubscribe'), request(3, 5)]);
  }
});

test('same-frame result attempts occur before or after the request subscription as configured', () => {
  for (const policy of policies) {
    const trace = [{ type: 'Query', at: 0, id: 1 }, { type: 'Result', at: 2, id: 1 }];
    const external = replayLifecycleTrace(trace, { policy, timerOrder: 'external-first' });
    const timer = replayLifecycleTrace(trace, { policy, timerOrder: 'timer-first' });
    assert.deepEqual(external.outputs, []);
    assert.deepEqual(external.requests, [request(1, 2)]);
    assert.deepEqual(timer.outputs, [{ at: 2, id: 1, value: 1 }]);
    assert.deepEqual(timer.requests, [request(1, 2, 2, 'complete')]);
  }
});

test('lifecycle replay preserves explicit payloads and rejects unsupported scheduling profiles', () => {
  const replay = replayLifecycleTrace([
    { type: 'Query', at: 0, id: 1 }, { type: 'Result', at: 3, id: 1, value: null },
  ]);
  assert.deepEqual(replay.outputs, [{ at: 3, id: 1, value: null }]);
  assert.throws(() => replayLifecycleTrace([], { delay: 0 }), /positive safe integer/);
  assert.throws(() => replayLifecycleTrace([{ type: 'Query', at: 0.5, id: 1 }]), /safe nonnegative integers/);
  assert.throws(() => replayLifecycleTrace([], { timerOrder: 'random' }), /Unknown timer order/);
});
