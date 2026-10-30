import { Observable, Subject } from 'rxjs';
import { TestScheduler } from 'rxjs/testing';
import {
  createDebouncedSearch$,
  createImmediateCancelSearch$,
} from './search-pipelines.mjs';

const policies = {
  debounced: createDebouncedSearch$,
  immediate: createImmediateCancelSearch$,
};

/**
 * Replay ordered external events against the real RxJS pipeline.
 *
 * Events: Query {at, id}, Result {at, id, value?}, Complete {at},
 * Unsubscribe {at}, and Advance {to}. Query IDs identify notifications, not values.
 * Result is one next followed immediately by inner completion. Canceled results
 * are attempted and recorded but cannot reach a closed request subscription.
 *
 * This adapter uses one explicitly live query Subject and one pipeline subscriber.
 * Every search is cold: its request record is created only upon subscription.
 * Time units come from the supplied virtual scheduler and equal one frame here.
 *
 * External events are enqueued in their given order before flushing. At an equal
 * frame, they therefore precede timers scheduled later by those source events.
 * The first TLA+ model excludes external events at timer deadlines. Tests outside
 * that model characterize both possible enqueue orders at a shared frame.
 *
 * @param {Array<object>} events
 * @param {{policy?: 'debounced'|'immediate', delay?: number, horizon?: number}} options
 */
export function replaySearchTrace(events, options = {}) {
  const { policy = 'immediate', delay = 3 } = options;
  const createSearch$ = policies[policy];
  if (!createSearch$) throw new Error(`Unknown search policy: ${policy}`);
  if (!Number.isFinite(delay) || delay < 0) {
    throw new Error('delay must be a finite, nonnegative number');
  }

  let previousTime = 0;
  const queryIds = new Set();
  const scheduled = events.map((event) => {
    const at = event.type === 'Advance' ? event.to : event.at;
    if (!Number.isFinite(at) || at < previousTime || at < 0) {
      throw new Error('Trace times must be finite, nonnegative, and nondecreasing');
    }
    previousTime = at;
    if (!['Query', 'Result', 'Complete', 'Unsubscribe', 'Advance'].includes(event.type)) {
      throw new Error(`Unknown trace event: ${event.type}`);
    }
    if (event.type === 'Query') {
      if (event.id === undefined || queryIds.has(event.id)) {
        throw new Error('Every Query needs a distinct notification id');
      }
      queryIds.add(event.id);
    }
    return { ...event, at };
  });
  const horizon = options.horizon ?? previousTime;
  if (!Number.isFinite(horizon) || horizon < previousTime) {
    throw new Error('horizon must be finite and include every external event');
  }

  const scheduler = new TestScheduler(() => {});
  scheduler.maxFrames = horizon;
  const queries$ = new Subject();
  const requests = [];
  const requestById = new Map();
  const outputs = [];
  const notifications = [];
  const violations = [];
  const log = [];
  let latestQueryId = null;
  let sourceTerminated = false;
  let recording = true;

  const record = (type, details = {}) => {
    if (recording) log.push({ at: scheduler.frame, type, ...details });
  };
  const search = (id) => new Observable((subscriber) => {
    const request = { id, start: scheduler.frame, stop: null, stopReason: null };
    const state = { subscriber, request, completed: false };
    requests.push(request);
    requestById.set(id, state);
    record('RequestStart', { id });
    return () => {
      if (!recording) return;
      request.stop = scheduler.frame;
      request.stopReason = state.completed ? 'complete' : 'unsubscribe';
      record('RequestStop', { id, reason: request.stopReason });
    };
  });

  const subscription = createSearch$(queries$, search, delay, scheduler).subscribe({
    next: ({ id, value }) => {
      const output = { at: scheduler.frame, id, value };
      outputs.push(output);
      notifications.push({ ...output, kind: 'N' });
      record('Next', { id, value });
      if (id !== latestQueryId) {
        violations.push({ at: scheduler.frame, resultId: id, latestQueryId });
      }
    },
    error: (error) => {
      const message = String(error?.message ?? error);
      notifications.push({ at: scheduler.frame, kind: 'E', error: message });
      record('Error', { error: message });
    },
    complete: () => {
      notifications.push({ at: scheduler.frame, kind: 'C' });
      record('Complete');
    },
  });

  for (const event of scheduled) {
    scheduler.schedule(() => {
      switch (event.type) {
        case 'Query':
          if (sourceTerminated) {
            record('IgnoredQuery', { id: event.id, reason: 'source-terminated' });
            break;
          }
          latestQueryId = event.id;
          record('Query', { id: event.id });
          queries$.next(event.id);
          break;
        case 'Result': {
          record('ResultAttempt', { id: event.id });
          const state = requestById.get(event.id);
          if (!state || state.subscriber.closed) {
            record('IgnoredResult', {
              id: event.id,
              reason: state ? 'subscription-closed' : 'request-not-started',
            });
            break;
          }
          const value = Object.hasOwn(event, 'value') ? event.value : event.id;
          state.subscriber.next({ id: event.id, value });
          state.completed = true;
          state.subscriber.complete();
          break;
        }
        case 'Complete':
          sourceTerminated = true;
          record('SourceComplete');
          queries$.complete();
          break;
        case 'Unsubscribe':
          record('Unsubscribe');
          subscription.unsubscribe();
          break;
        case 'Advance':
          record('Advance');
          break;
      }
    }, event.at);
  }
  scheduler.schedule(() => {}, horizon);

  try {
    scheduler.flush();
    return {
      policy,
      delay,
      horizon,
      outputs,
      notifications,
      requests: requests.map((request) => ({ ...request })),
      violations,
      log,
    };
  } finally {
    // Cleanup is outside the observed trace and must not invent model events.
    recording = false;
    subscription.unsubscribe();
    queries$.complete();
  }
}
