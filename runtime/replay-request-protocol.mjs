import { Observable, Subject } from 'rxjs';
import { TestScheduler } from 'rxjs/testing';
import { createDebouncedSearch$, createImmediateCancelSearch$ } from './search-pipelines.mjs';

const eventTypes = new Set([
  'Query', 'InnerNext', 'InnerComplete', 'InnerError',
  'SourceComplete', 'SourceError', 'Cancel', 'Advance',
]);
const innerEvents = new Set(['InnerNext', 'InnerComplete', 'InnerError']);
const errorText = (error) => String(error?.message ?? error);

/**
 * Replay one subscribed search dataflow with independent request notifications.
 *
 * Query {at,id}; InnerNext {at,id,value?}; InnerComplete {at,id};
 * InnerError {at,id,error?}; SourceComplete {at}; SourceError {at,error?};
 * Cancel {at}; Advance {to}. Query IDs identify individual notifications.
 * An accepted next receives a 1-based index within that request. The index is
 * observation metadata; the payload is opaque and retains its identity.
 *
 * Each request is cold: subscribing starts its recorded lifetime. External
 * actions drive zero or more next notifications, independently followed by
 * complete or error. Requests may remain open at the observation horizon.
 * The source is a live Subject with one pipeline subscriber; there is no sharing.
 *
 * External-first queues all input before flushing. Timer-first queues input at
 * t from a wrapper at t - 0.5 (or 0 for t=0), after relevant timers were created
 * or rearmed at an earlier integer frame. Same-frame inputs retain trace order.
 * This profile requires positive integer delays and integer input frames. It
 * excludes arbitrary mixed ordering, zero-delay timers, reentrant observers,
 * and synchronous emissions during the request's subscription callback.
 * Returned ownership describes the observed horizon, before cleanup.
 */
export function replayRequestProtocol(events, options = {}) {
  const { policy = 'immediate', timerOrder = 'external-first', delay = 2 } = options;
  if (!['debounced', 'immediate'].includes(policy)) throw new Error('Unknown search policy: ' + policy);
  if (!['external-first', 'timer-first'].includes(timerOrder)) throw new Error('Unknown timer order: ' + timerOrder);
  if (!Number.isSafeInteger(delay) || delay <= 0) throw new Error('delay must be a positive safe integer');
  if (!Array.isArray(events)) throw new Error('events must be an array');

  let previousTime = 0;
  const queryIds = new Set();
  const scheduled = events.map((event) => {
    if (!event || !eventTypes.has(event.type)) throw new Error('Unknown request protocol event: ' + event?.type);
    const at = event.type === 'Advance' ? event.to : event.at;
    if (!Number.isSafeInteger(at) || at < previousTime || at < 0 || !Number.isSafeInteger(at + delay)) {
      throw new Error('Trace times must be safe nonnegative integers in nondecreasing order');
    }
    if (timerOrder === 'timer-first' && at > 0 && !(at - 1 < at - 0.5 && at - 0.5 < at)) {
      throw new Error('Trace time is too large for the timer-first enqueue profile');
    }
    if ((event.type === 'Query' || innerEvents.has(event.type))
      && (!Number.isSafeInteger(event.id) || event.id <= 0)) {
      throw new Error(event.type + ' needs a positive safe integer notification id');
    }
    if (event.type === 'Query') {
      if (queryIds.has(event.id)) throw new Error('Every Query needs a distinct notification id');
      queryIds.add(event.id);
    }
    previousTime = at;
    return { ...event, at };
  });
  const horizon = options.horizon ?? previousTime;
  if (!Number.isSafeInteger(horizon) || horizon < previousTime) {
    throw new Error('horizon must be a safe integer including every external event');
  }

  const scheduler = new TestScheduler(() => {});
  scheduler.maxFrames = horizon;
  const rawQueries = new Subject();
  const requests = [];
  const requestById = new Map();
  const acceptedQueries = [];
  const acceptedInnerNotifications = [];
  const outputs = [];
  const notifications = [];
  const violations = [];
  const log = [];
  const sourceLifetime = { start: 0, stop: null, stopReason: null };
  let sourceOwned = false;
  let sourceState = 'open';
  let destinationState = 'open';
  let latestQueryId = null;
  let recording = true;
  const record = (type, details = {}) => {
    if (recording) log.push({ at: scheduler.frame, type, ...details });
  };
  const queries$ = new Observable((subscriber) => {
    sourceOwned = true;
    record('SourceSubscribe');
    const connection = rawQueries.subscribe(subscriber);
    return () => {
      connection.unsubscribe();
      if (!recording) return;
      sourceOwned = false;
      if (sourceState === 'open') sourceState = 'unsubscribed';
      sourceLifetime.stop = scheduler.frame;
      sourceLifetime.stopReason = sourceState === 'completed' ? 'complete'
        : sourceState === 'errored' ? 'error' : 'unsubscribe';
      record('SourceStop', { reason: sourceLifetime.stopReason });
    };
  });
  const search = (id) => new Observable((subscriber) => {
    const request = { id, start: scheduler.frame, stop: null, stopReason: null, nextCount: 0 };
    const state = { subscriber, request, terminal: null };
    requests.push(state);
    requestById.set(id, state);
    record('RequestStart', { id });
    return () => {
      if (!recording) return;
      request.stop = scheduler.frame;
      request.stopReason = state.terminal ?? 'unsubscribe';
      record('RequestStop', { id, reason: request.stopReason });
    };
  });
  const createSearch$ = policy === 'debounced' ? createDebouncedSearch$ : createImmediateCancelSearch$;
  const subscription = createSearch$(queries$, search, delay, scheduler).subscribe({
    next: ({ id, index, value }) => {
      const output = { at: scheduler.frame, id, index, value };
      outputs.push(output);
      notifications.push({ ...output, kind: 'N' });
      record('Next', { id, index, value });
      if (id !== latestQueryId) violations.push({ at: scheduler.frame, resultId: id, latestQueryId });
    },
    complete: () => {
      destinationState = 'completed';
      notifications.push({ at: scheduler.frame, kind: 'C' });
      record('Complete');
    },
    error: (error) => {
      destinationState = 'errored';
      notifications.push({ at: scheduler.frame, kind: 'E', error: errorText(error) });
      record('Error', { error: errorText(error) });
    },
  });

  const deliver = (event) => {
    const sourceAccepts = sourceOwned && sourceState === 'open' && destinationState === 'open';
    switch (event.type) {
      case 'Query':
        if (!sourceAccepts) { record('IgnoredQuery', { id: event.id }); break; }
        latestQueryId = event.id;
        acceptedQueries.push({ at: scheduler.frame, id: event.id });
        record('Query', { id: event.id });
        rawQueries.next(event.id);
        break;
      case 'SourceComplete':
        if (!sourceAccepts) { record('IgnoredSourceComplete'); break; }
        sourceState = 'completed';
        record('SourceComplete');
        rawQueries.complete();
        break;
      case 'SourceError': {
        if (!sourceAccepts) { record('IgnoredSourceError'); break; }
        sourceState = 'errored';
        const error = Object.hasOwn(event, 'error') ? event.error : new Error('source failed');
        record('SourceError', { error: errorText(error) });
        rawQueries.error(error);
        break;
      }
      case 'InnerNext':
      case 'InnerComplete':
      case 'InnerError': {
        const state = requestById.get(event.id);
        record(event.type + 'Attempt', { id: event.id });
        if (!state || state.subscriber.closed) {
          record('Ignored' + event.type, { id: event.id, reason: state ? 'subscription-closed' : 'request-not-started' });
          break;
        }
        if (event.type === 'InnerNext') {
          const index = ++state.request.nextCount;
          const value = Object.hasOwn(event, 'value') ? event.value : event.id;
          acceptedInnerNotifications.push({ at: scheduler.frame, id: event.id, kind: 'N', index, value });
          record('InnerNext', { id: event.id, index, value });
          state.subscriber.next({ id: event.id, index, value });
        } else if (event.type === 'InnerComplete') {
          state.terminal = 'complete';
          acceptedInnerNotifications.push({ at: scheduler.frame, id: event.id, kind: 'C' });
          record('InnerComplete', { id: event.id });
          state.subscriber.complete();
        } else {
          state.terminal = 'error';
          const error = Object.hasOwn(event, 'error') ? event.error : new Error('request failed');
          acceptedInnerNotifications.push({ at: scheduler.frame, id: event.id, kind: 'E', error: errorText(error) });
          record('InnerError', { id: event.id, error: errorText(error) });
          state.subscriber.error(error);
        }
        break;
      }
      case 'Cancel':
        if (destinationState !== 'open') { record('IgnoredCancel'); break; }
        destinationState = 'cancelled';
        record('Cancel');
        subscription.unsubscribe();
        break;
      case 'Advance':
        record('Advance');
        break;
    }
  };

  for (const event of scheduled) {
    if (timerOrder === 'external-first') {
      scheduler.schedule(() => deliver(event), event.at);
    } else {
      const enqueueAt = Math.max(0, event.at - 0.5);
      scheduler.schedule(() => {
        scheduler.schedule(() => deliver(event), event.at - scheduler.frame);
      }, enqueueAt);
    }
  }
  scheduler.schedule(() => {}, horizon);
  try {
    scheduler.flush();
    return {
      policy, timerOrder, delay, horizon, latestQueryId, sourceState, destinationState,
      sourceOwned, sourceLifetime: { ...sourceLifetime }, destinationClosed: subscription.closed,
      acceptedQueries, acceptedInnerNotifications, outputs, notifications, violations, log,
      requests: requests.map(({ request, subscriber }) => ({ ...request, closed: subscriber.closed })),
    };
  } finally {
    // Cleanup is outside the observation; it adds no modeled terminal notification.
    recording = false;
    subscription.unsubscribe();
    rawQueries.complete();
  }
}
