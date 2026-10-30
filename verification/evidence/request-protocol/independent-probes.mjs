import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run from the repository root, or pass its path as the first argument.
const repo = resolve(process.argv[2] ?? process.cwd());
const require = createRequire(repo + '/package.json');
const { Observable, Subject } = require('rxjs');
const { TestScheduler } = require('rxjs/testing');
const { createDebouncedSearch$, createImmediateCancelSearch$ } = await import(pathToFileURL(repo + '/runtime/search-pipelines.mjs'));

// Independent evidence: call retained real RxJS Subscribers even after teardown.
// No production replay adapter, model decoder, or evidence helper is imported.
const run = (events, { policy, order, horizon = 10 }) => {
  const scheduler = new TestScheduler(() => {});
  scheduler.maxFrames = horizon;
  const source = new Subject();
  const held = new Map();
  const requests = [];
  const outputs = [];
  const snapshots = [];
  let sourceStop = null;
  let destination = 'open';
  let recording = true;
  const source$ = new Observable(subscriber => {
    const connection = source.subscribe(subscriber);
    return () => { connection.unsubscribe(); if (recording) sourceStop = scheduler.frame; };
  });
  const search = id => new Observable(subscriber => {
    const request = { id, start: scheduler.frame, stop: null, reason: null };
    const state = { subscriber, request, terminal: null };
    held.set(id, state);
    requests.push(request);
    return () => { if (recording) { request.stop = scheduler.frame; request.reason = state.terminal ?? 'unsubscribe'; } };
  });
  const factory = policy === 'debounced' ? createDebouncedSearch$ : createImmediateCancelSearch$;
  const subscription = factory(source$, search, 2, scheduler).subscribe({
    next: value => outputs.push({ at: scheduler.frame, kind: 'N', ...value }),
    complete: () => { destination = 'completed'; outputs.push({ at: scheduler.frame, kind: 'C' }); },
    error: error => { destination = 'errored'; outputs.push({ at: scheduler.frame, kind: 'E', error }); },
  });
  const deliver = ([at, event, id, value]) => {
    const state = held.get(id);
    if (event === 'Q') source.next(id);
    else if (event === 'SC') source.complete();
    else if (event === 'SE') source.error(value ?? 'source-error');
    else if (event === 'X') { if (!subscription.closed) destination = 'cancelled'; subscription.unsubscribe(); }
    else if (state) {
      // Deliberately DO NOT skip closed subscribers. RxJS must suppress them.
      if (event === 'N') state.subscriber.next({ id, value });
      else if (event === 'C') { if (!state.subscriber.closed) state.terminal = 'complete'; state.subscriber.complete(); }
      else if (event === 'E') { if (!state.subscriber.closed) state.terminal = 'error'; state.subscriber.error(value ?? 'inner-error'); }
    }
    snapshots.push({ at, event, id, destination, active: [...held].filter(([, s]) => !s.subscriber.closed).map(([key]) => key) });
  };
  for (const event of events) {
    if (order === 'external-first') scheduler.schedule(() => deliver(event), event[0]);
    else scheduler.schedule(() => scheduler.schedule(() => deliver(event), event[0] - scheduler.frame), Math.max(0, event[0] - 0.25));
  }
  scheduler.schedule(() => {}, horizon);
  scheduler.flush();
  const result = { outputs, requests, snapshots, destination, closed: subscription.closed, sourceStop };
  recording = false;
  subscription.unsubscribe();
  source.complete();
  return result;
};

const n = (at, id, value) => ({ at, kind: 'N', id, value });
const c = at => ({ at, kind: 'C' });
const e = (at, error) => ({ at, kind: 'E', error });
let probes = 0;
for (const policy of ['debounced', 'immediate']) {
  for (const order of ['external-first', 'timer-first']) {
    const check = (name, events, verify) => {
      const result = run(events, { policy, order });
      verify(result);
      probes++;
      console.log(JSON.stringify({ name, policy, order, outputs: result.outputs, requests: result.requests, destination: result.destination, sourceStop: result.sourceStop }));
    };

    check('source completion waits through independent nexts', [[0,'Q',1],[3,'SC'],[4,'N',1,'a'],[5,'N',1,'b'],[6,'C',1]], r => {
      assert.deepEqual(r.outputs, [n(4,1,'a'), n(5,1,'b'), c(6)]);
      assert.deepEqual(r.snapshots.filter(s => s.event === 'N').map(s => [s.destination, s.active]), [['open',[1]],['open',[1]]]);
      assert.equal(r.requests[0].stop,6);
      assert.equal(r.sourceStop,3);
    });
    check('empty completion after completed source', [[0,'Q',1],[1,'SC'],[3,'C',1],[4,'N',1,'late'],[5,'E',1,'late-error']], r => {
      assert.deepEqual(r.outputs,[c(3)]);
      assert.equal(r.requests[0].start,policy === 'debounced' ? 1 : 2);
      assert.equal(r.requests[0].reason,'complete');
    });
    check('empty completion returns to source-open idle', [[0,'Q',1],[3,'C',1],[4,'Q',2],[7,'N',2,'new'],[8,'C',2],[9,'SC']], r => {
      assert.deepEqual(r.outputs,[n(7,2,'new'),c(9)]);
      assert.equal(r.snapshots.find(s => s.event === 'C').destination,'open');
      assert.deepEqual(r.requests.map(x => [x.id,x.reason]),[[1,'complete'],[2,'complete']]);
    });
    check('values followed by inner error suppress all late terminal attempts', [[0,'Q',1],[3,'N',1,'a'],[4,'SC'],[5,'E',1,'boom'],[6,'N',1,'late'],[6,'C',1],[6,'E',1,'again']], r => {
      assert.deepEqual(r.outputs,[n(3,1,'a'),e(5,'boom')]);
      assert.equal(r.requests[0].reason,'error');
    });
    check('source error after next tears down inner', [[0,'Q',1],[3,'N',1,'a'],[4,'SE',0,'source-failed'],[5,'N',1,'late'],[5,'C',1],[5,'E',1,'late']], r => {
      assert.deepEqual(r.outputs,[n(3,1,'a'),e(4,'source-failed')]);
      assert.equal(r.requests[0].reason,'unsubscribe');
    });
    check('cancel between values suppresses held subscriber next complete error', [[0,'Q',1],[3,'N',1,'a'],[4,'X'],[5,'N',1,'late'],[5,'C',1],[5,'E',1,'late']], r => {
      assert.deepEqual(r.outputs,[n(3,1,'a')]);
      assert.equal(r.destination,'cancelled');
      assert.equal(r.requests[0].stop,4);
    });
    check('old completion preserves pending newer query', [[0,'Q',1],[3,'N',1,'a'],[4,'Q',2],[5,'C',1],[7,'N',2,'b'],[8,'C',2],[9,'SC']], r => {
      assert.deepEqual(r.outputs,[n(3,1,'a'),n(7,2,'b'),c(9)]);
      assert.equal(r.requests[0].reason,policy === 'debounced' ? 'complete' : 'unsubscribe');
      assert.equal(r.requests[1].start,6);
    });
    check('older next during newer debounce is stale only in debounced policy', [[0,'Q',1],[3,'N',1,'a'],[4,'Q',2],[5,'N',1,'stale'],[7,'N',2,'b'],[8,'C',2],[9,'SC']], r => {
      assert.deepEqual(r.outputs,policy === 'debounced' ? [n(3,1,'a'),n(5,1,'stale'),n(7,2,'b'),c(9)] : [n(3,1,'a'),n(7,2,'b'),c(9)]);
    });
    check('older error while newer query pending follows active subscription', [[0,'Q',1],[3,'N',1,'a'],[4,'Q',2],[5,'E',1,'old-error'],[7,'N',2,'b'],[8,'C',2],[9,'SC']], r => {
      assert.deepEqual(r.outputs,policy === 'debounced' ? [n(3,1,'a'),e(5,'old-error')] : [n(3,1,'a'),n(7,2,'b'),c(9)]);
      assert.equal(r.requests.length,policy === 'debounced' ? 1 : 2);
    });
    check('same frame notification order stays next next complete', [[0,'Q',1],[3,'N',1,'same'],[3,'N',1,'same'],[3,'C',1],[3,'N',1,'late'],[4,'SC']], r => {
      assert.deepEqual(r.outputs,[n(3,1,'same'),n(3,1,'same'),c(4)]);
      assert.equal(r.requests[0].stop,3);
      assert.equal(r.snapshots.filter(s=>s.event==='N')[1].destination,'open');
    });
    check('next alone cannot finish a completed source', [[0,'Q',1],[1,'SC'],[3,'N',1,'only']], r => {
      assert.deepEqual(r.outputs,[n(3,1,'only')]);
      assert.equal(r.closed,false);
      assert.equal(r.destination,'open');
      assert.equal(r.requests[0].stop,null);
    });
    check('explicit boundary profile reveals transient subscription', [[0,'Q',1],[2,'Q',2],[2,'N',1,'boundary'],[5,'N',2,'current'],[6,'C',2],[7,'SC']], r => {
      const oldOutput = order === 'timer-first' && policy === 'debounced';
      assert.deepEqual(r.outputs,oldOutput ? [n(2,1,'boundary'),n(5,2,'current'),c(7)] : [n(5,2,'current'),c(7)]);
      if (order === 'external-first') assert.deepEqual(r.requests.map(x=>x.id),[2]);
      else {
        assert.deepEqual(r.requests.map(x=>x.id),[1,2]);
        assert.equal(r.requests[0].stop,policy === 'immediate' ? 2 : 4);
      }
    });
  }
}
console.log(`All ${probes} independent held-subscriber probes passed.`);
