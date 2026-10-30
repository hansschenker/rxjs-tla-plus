import assert from 'node:assert/strict';
import test from 'node:test';
import { Observable, Subject } from 'rxjs';
import { TestScheduler } from 'rxjs/testing';
import {
  createDebouncedSearch$,
  createImmediateCancelSearch$,
} from '../runtime/search-pipelines.mjs';
import { replaySearchTrace } from '../runtime/replay-search-trace.mjs';

const freshnessTrace = [
  { type: 'Query', at: 0, id: 1 },
  { type: 'Query', at: 4, id: 2 },
  { type: 'Result', at: 5, id: 1 },
  { type: 'Result', at: 8, id: 2 },
  { type: 'Advance', to: 9 },
];

test('debounce before switchMap permits an old result during the next silence wait', () => {
  const replay = replaySearchTrace(freshnessTrace, { policy: 'debounced' });
  assert.deepEqual(replay.outputs, [
    { at: 5, id: 1, value: 1 },
    { at: 8, id: 2, value: 2 },
  ]);
  assert.deepEqual(replay.violations, [{ at: 5, resultId: 1, latestQueryId: 2 }]);
  assert.deepEqual(replay.requests, [
    { id: 1, start: 3, stop: 5, stopReason: 'complete' },
    { id: 2, start: 7, stop: 8, stopReason: 'complete' },
  ]);
});

test('the immediate policy closes the old request when raw input arrives', () => {
  const replay = replaySearchTrace(freshnessTrace, { policy: 'immediate' });
  assert.deepEqual(replay.outputs, [{ at: 8, id: 2, value: 2 }]);
  assert.deepEqual(replay.violations, []);
  assert.deepEqual(replay.requests, [
    { id: 1, start: 3, stop: 4, stopReason: 'unsubscribe' },
    { id: 2, start: 7, stop: 8, stopReason: 'complete' },
  ]);
  assert.ok(replay.log.some((event) => (
    event.type === 'IgnoredResult' && event.at === 5 && event.id === 1
  )));
});

test('replay defaults only an absent result payload and preserves null or undefined', () => {
  for (const [payload, expected] of [
    [{}, 1],
    [{ value: null }, null],
    [{ value: undefined }, undefined],
  ]) {
    const replay = replaySearchTrace([
      { type: 'Query', at: 0, id: 1 },
      { type: 'Result', at: 4, id: 1, ...payload },
    ]);
    assert.deepEqual(replay.outputs, [{ at: 4, id: 1, value: expected }]);
    assert.deepEqual(replay.notifications, [{ at: 4, id: 1, value: expected, kind: 'N' }]);
    assert.deepEqual(replay.violations, []);
  }
});

test('source completion flushes debounceTime but lets the selected timer finish', () => {
  const trace = [
    { type: 'Query', at: 0, id: 1 },
    { type: 'Complete', at: 1 },
    { type: 'Result', at: 4, id: 1 },
  ];
  const debounced = replaySearchTrace(trace, { policy: 'debounced' });
  const immediate = replaySearchTrace(trace, { policy: 'immediate' });
  assert.equal(debounced.requests[0].start, 1);
  assert.equal(immediate.requests[0].start, 3);
  for (const replay of [debounced, immediate]) {
    assert.deepEqual(replay.notifications, [
      { at: 4, id: 1, value: 1, kind: 'N' },
      { at: 4, kind: 'C' },
    ]);
  }
});

test('queries after source completion do not invalidate the final accepted request', () => {
  const trace = [
    { type: 'Query', at: 0, id: 1 },
    { type: 'Complete', at: 1 },
    { type: 'Query', at: 2, id: 2 },
    { type: 'Result', at: 4, id: 1 },
  ];
  for (const policy of ['debounced', 'immediate']) {
    const replay = replaySearchTrace(trace, { policy });
    assert.deepEqual(replay.outputs, [{ at: 4, id: 1, value: 1 }]);
    assert.deepEqual(replay.violations, []);
    assert.deepEqual(replay.requests, [{
      id: 1,
      start: policy === 'debounced' ? 1 : 3,
      stop: 4,
      stopReason: 'complete',
    }]);
    assert.deepEqual(replay.notifications, [
      { at: 4, id: 1, value: 1, kind: 'N' },
      { at: 4, kind: 'C' },
    ]);
    assert.ok(replay.log.some((event) => (
      event.type === 'IgnoredQuery' && event.at === 2 && event.id === 2
    )));
  }
});

test('downstream cancellation closes the request and suppresses later work', () => {
  const replay = replaySearchTrace([
    { type: 'Query', at: 0, id: 1 },
    { type: 'Unsubscribe', at: 4 },
    { type: 'Result', at: 5, id: 1 },
    { type: 'Query', at: 6, id: 2 },
    { type: 'Advance', to: 10 },
  ]);
  assert.deepEqual(replay.requests, [
    { id: 1, start: 3, stop: 4, stopReason: 'unsubscribe' },
  ]);
  assert.deepEqual(replay.notifications, []);
});

test('downstream cancellation during the silence wait prevents a request', () => {
  const replay = replaySearchTrace([
    { type: 'Query', at: 0, id: 1 },
    { type: 'Unsubscribe', at: 1 },
    { type: 'Advance', to: 5 },
  ]);
  assert.deepEqual(replay.requests, []);
  assert.deepEqual(replay.notifications, []);
});

test('a cold source and request execute only after subscription and tear down', () => {
  for (const createSearch$ of [createDebouncedSearch$, createImmediateCancelSearch$]) {
    const scheduler = new TestScheduler(() => {});
    let sourceConnections = 0;
    let sourceTeardowns = 0;
    let requestConnections = 0;
    let requestTeardowns = 0;
    const queries$ = new Observable((subscriber) => {
      sourceConnections += 1;
      subscriber.next(1);
      return () => { sourceTeardowns += 1; };
    });
    const search = () => new Observable(() => {
      requestConnections += 1;
      return () => { requestTeardowns += 1; };
    });
    const result$ = createSearch$(queries$, search, 3, scheduler);
    assert.equal(sourceConnections, 0);
    assert.equal(requestConnections, 0);
    const subscription = result$.subscribe();
    assert.equal(sourceConnections, 1);
    assert.equal(requestConnections, 0);
    scheduler.flush();
    assert.equal(requestConnections, 1);
    subscription.unsubscribe();
    assert.equal(sourceTeardowns, 1);
    assert.equal(requestTeardowns, 1);
  }
});

test('source errors discard waiting input or close the active request', () => {
  for (const createSearch$ of [createDebouncedSearch$, createImmediateCancelSearch$]) {
    for (const errorAt of [1, 4]) {
      const scheduler = new TestScheduler(() => {});
      const queries$ = new Subject();
      const requests = [];
      const notifications = [];
      const search = (id) => new Observable(() => {
        const request = { id, start: scheduler.frame, stop: null };
        requests.push(request);
        return () => { request.stop = scheduler.frame; };
      });
      const subscription = createSearch$(queries$, search, 3, scheduler).subscribe({
        next: (value) => notifications.push({ kind: 'N', value }),
        error: (error) => notifications.push({
          at: scheduler.frame, kind: 'E', message: error.message,
        }),
        complete: () => notifications.push({ kind: 'C' }),
      });
      scheduler.schedule(() => queries$.next(1), 0);
      scheduler.schedule(() => queries$.error(new Error('source failed')), errorAt);
      scheduler.flush();
      assert.deepEqual(notifications, [{ at: errorAt, kind: 'E', message: 'source failed' }]);
      assert.deepEqual(requests, errorAt === 1 ? [] : [{ id: 1, start: 3, stop: 4 }]);
      assert.equal(subscription.closed, true);
    }
  }
});

test('equal-time raw input and timer work follow their enqueue order', () => {
  const observe = (timerFirst) => {
    const scheduler = new TestScheduler(() => {});
    scheduler.maxFrames = 7;
    const queries$ = new Subject();
    const log = [];
    const search = (id) => new Observable(() => {
      log.push({ at: scheduler.frame, type: 'start', id });
      return () => log.push({ at: scheduler.frame, type: 'stop', id });
    });
    const subscription = createImmediateCancelSearch$(queries$, search, 3, scheduler).subscribe();
    scheduler.schedule(() => queries$.next(1), 0);
    if (timerFirst) {
      scheduler.schedule(() => {
        scheduler.schedule(() => queries$.next(2), 2);
      }, 1);
    } else {
      scheduler.schedule(() => queries$.next(2), 3);
    }
    scheduler.flush();
    const observed = [...log];
    subscription.unsubscribe();
    return observed;
  };

  assert.deepEqual(observe(false), [{ at: 6, type: 'start', id: 2 }]);
  assert.deepEqual(observe(true), [
    { at: 3, type: 'start', id: 1 },
    { at: 3, type: 'stop', id: 1 },
    { at: 6, type: 'start', id: 2 },
  ]);
});
