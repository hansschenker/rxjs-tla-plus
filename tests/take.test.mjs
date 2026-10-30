import assert from 'node:assert/strict';
import test from 'node:test';
import { Observable, take } from 'rxjs';

const next = value => ({ type: 'next', value });
const complete = { type: 'complete' };
const cancel = { type: 'cancel' };
const sourceFailure = new Error('source failed');
const error = { type: 'error', error: sourceFailure };

// Inputs are delivered one at a time, after the preceding delivery returns.
// This is the non-reentrant profile used by experiments/01-take/Take.tla.
function runTake(count, events) {
  let sourceSubscriber;
  let acquisitions = 0;
  let releases = 0;
  const notifications = [];
  const actions = [];
  const snapshots = [];

  const source$ = new Observable(subscriber => {
    sourceSubscriber = subscriber;
    acquisitions += 1;
    actions.push('source.subscribe');
    return () => {
      releases += 1;
      actions.push('source.unsubscribe');
    };
  });
  const subscription = source$.pipe(take(count)).subscribe({
    next: value => {
      notifications.push({ kind: 'next', value });
      actions.push('notify.next');
    },
    complete: () => {
      notifications.push({ kind: 'complete' });
      actions.push('notify.complete');
    },
    error: failure => {
      notifications.push({ kind: 'error', error: failure });
      actions.push('notify.error');
    },
  });

  const record = () => snapshots.push({
    closed: subscription.closed,
    notificationCount: notifications.length,
    acquisitions,
    releases,
  });
  record();
  for (const event of events) {
    switch (event.type) {
      case 'next': sourceSubscriber?.next(event.value); break;
      case 'complete': sourceSubscriber?.complete(); break;
      case 'error': sourceSubscriber?.error(event.error); break;
      case 'cancel': subscription.unsubscribe(); break;
      default: throw new Error(`Unknown test input: ${event.type}`);
    }
    record();
  }

  const result = {
    notifications: [...notifications],
    actions: [...actions],
    acquisitions,
    releases,
    closed: subscription.closed,
    snapshots,
  };
  // Clean up unfinished prefixes after capturing their observable result.
  subscription.unsubscribe();
  return result;
}

function assertQuota(result, quota) {
  const delivered = result.notifications.filter(item => item.kind === 'next').length;
  assert.ok(delivered <= quota, `QuotaBound: ${delivered} > ${quota}`);
}

function assertLifecycle(result, quota) {
  assertQuota(result, quota);
  const terminalIndex = result.notifications.findIndex(item => item.kind !== 'next');
  if (terminalIndex >= 0) {
    assert.equal(terminalIndex, result.notifications.length - 1,
      'a terminal notification must be unique and last');
  }
  assert.equal(result.acquisitions, quota === 0 ? 0 : 1);
  assert.equal(result.releases, result.closed && quota > 0 ? 1 : 0);
  for (let index = 1; index < result.snapshots.length; index += 1) {
    const previous = result.snapshots[index - 1];
    const current = result.snapshots[index];
    if (previous.closed) assert.deepEqual(current, previous,
      'later source attempts must not change a closed subscription');
  }
}

function* histories(alphabet, remaining, prefix = []) {
  yield prefix;
  if (remaining === 0) return;
  for (const event of alphabet) yield* histories(alphabet, remaining - 1, [...prefix, event]);
}

test('take describes a lazy dataflow until subscribed', () => {
  let acquisitions = 0;
  const source$ = new Observable(() => { acquisitions += 1; });
  const result$ = source$.pipe(take(2));
  assert.equal(acquisitions, 0);
  const subscription = result$.subscribe();
  assert.equal(acquisitions, 1);
  subscription.unsubscribe();
});

test('take(0) completes without acquiring the source', () => {
  const result = runTake(0, [next('a'), error, complete, cancel]);
  assert.deepEqual(result.notifications, [{ kind: 'complete' }]);
  assert.deepEqual(result.actions, ['notify.complete']);
  assertLifecycle(result, 0);
});

test('take(2) forwards the second value, completes, and releases the source', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const result = runTake(2, [next(a), next(b), next('ignored'), error, complete, cancel]);
  assert.deepEqual(result.notifications, [
    { kind: 'next', value: a }, { kind: 'next', value: b }, { kind: 'complete' },
  ]);
  assert.equal(result.notifications[0].value, a, 'payload identity is preserved');
  assert.equal(result.notifications[1].value, b, 'payload identity is preserved');
  assert.deepEqual(result.actions, [
    'source.subscribe', 'notify.next', 'notify.next', 'notify.complete', 'source.unsubscribe',
  ]);
  assertLifecycle(result, 2);
});

test('source completion before the quota completes with the existing prefix', () => {
  const result = runTake(2, [next('a'), complete, next('ignored')]);
  assert.deepEqual(result.notifications, [{ kind: 'next', value: 'a' }, { kind: 'complete' }]);
  assertLifecycle(result, 2);
});

test('source error preserves the error object and never adds complete', () => {
  const result = runTake(2, [next('a'), error, complete, next('ignored')]);
  assert.deepEqual(result.notifications, [
    { kind: 'next', value: 'a' }, { kind: 'error', error: sourceFailure },
  ]);
  assert.equal(result.notifications[1].error, sourceFailure);
  assertLifecycle(result, 2);
});

test('downstream cancellation releases the source without a terminal notification', () => {
  const result = runTake(2, [next('a'), cancel, next('ignored'), complete, error]);
  assert.deepEqual(result.notifications, [{ kind: 'next', value: 'a' }]);
  assert.deepEqual(result.actions, ['source.subscribe', 'notify.next', 'source.unsubscribe']);
  assertLifecycle(result, 2);
});

test('two subscriptions have independent take counters and source lifetimes', () => {
  const sources = [];
  let releases = 0;
  const source$ = new Observable(subscriber => {
    sources.push(subscriber);
    return () => { releases += 1; };
  });
  const result$ = source$.pipe(take(2));
  const first = [];
  const second = [];
  const one = result$.subscribe(value => first.push(value));
  const two = result$.subscribe(value => second.push(value));
  assert.equal(sources.length, 2);
  sources[0].next('a');
  sources[0].next('b');
  assert.equal(one.closed, true);
  assert.equal(two.closed, false);
  sources[1].next('x');
  assert.deepEqual(first, ['a', 'b']);
  assert.deepEqual(second, ['x']);
  assert.equal(releases, 1);
  two.unsubscribe();
  assert.equal(releases, 2);
});

test('quota and lifecycle checks hold for all 312 bounded runtime histories', () => {
  const alphabet = [next('a'), next('b'), complete, error, cancel];
  let checked = 0;
  for (const quota of [0, 2]) {
    for (const events of histories(alphabet, 3)) {
      assertLifecycle(runTake(quota, events), quota);
      checked += 1;
    }
  }
  assert.equal(checked, 312);
});

test('the runtime quota oracle rejects the deliberate take(3) mutant for quota 2', () => {
  const mutant = runTake(3, [next('a'), next('b'), next('a')]);
  assert.equal(mutant.notifications.filter(item => item.kind === 'next').length, 3);
  assert.throws(() => assertQuota(mutant, 2), {
    name: 'AssertionError',
    message: 'QuotaBound: 3 > 2',
  });
});
