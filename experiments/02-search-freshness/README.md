# Experiment 02: search freshness and cancellation timing

## Question

**Can a search result be delivered after a newer raw query has arrived?**

This experiment compares two RxJS `7.8.2` pipelines implemented in
[`runtime/search-pipelines.mjs`](../../runtime/search-pipelines.mjs):

```js
// Baseline: wait for silence, then replace the selected request.
queries$.pipe(
  debounceTime(delay, scheduler),
  switchMap(search),
);

// Candidate: replace the waiting timer/request flow on every raw query.
queries$.pipe(
  switchMap(query => timer(delay, scheduler).pipe(
    switchMap(() => search(query)),
  )),
);
```

In the baseline, a new raw query resets the silence wait while the old request
remains subscribed. That request can deliver during the wait. In the candidate,
each raw query immediately unsubscribes the preceding timer or request flow and
starts a new wait.

The property is measured against the latest accepted **raw query notification**:
every emitted result must belong to that notification. IDs identify individual
notifications; the model does not compare query strings or result payloads.

[`SearchFreshness.tla`](SearchFreshness.tla) is a handwritten abstraction of this
specific interaction. The runtime replay supplies separate evidence that one
TLC counterexample occurs in the actual RxJS pipeline. There is no automatic
translation or proved equivalence between the JavaScript and TLA+ programs.

## Model and runtime mapping

The model starts with one open downstream execution, no pending query, and no
active request. Its principal state variables are `latestRaw`, `pending`,
`deadline`, and `active`. Zero denotes the absence of a query or request.

| Model action | Baseline: `Policy = "debounced"` | Candidate: `Policy = "immediate"` |
|---|---|---|
| `Query` | Record the new raw notification and reset its debounce deadline; retain the active request | Record the new raw notification and deadline; close the preceding timer/request flow immediately |
| `Timer` | Deliver the pending debounced query to `switchMap`, replacing any active request | The selected timer fires and subscribes its request |
| `Result` | The selected request emits one result and completes; compare its ID with `latestRaw` | The selected request emits one result and completes; compare its ID with `latestRaw` |
| `Cancel` | Downstream unsubscription clears pending and active work | Downstream unsubscription clears pending and active work |
| `Tick` | Advance integer virtual time by one when no pending timer is due | Same |
| `HorizonStop` | Allow the execution to remain at the finite observation horizon | Same |

`started` and `delivered` record request IDs for invariant checks. `badEmission`
remembers whether any delivered result belonged to an older raw notification.
The last event and ID are observation variables used to decode the trace.

The model has a result transition only for the selected request. The runtime
adapter additionally attempts results for canceled requests and records their
suppression by closed RxJS subscriptions. Closing a subscription is the modeled
ownership action. Aborting a physical network operation requires the request
factory's teardown to perform that abort.

### Invariants and controls

| Invariant | Meaning |
|---|---|
| `TypeOK` | State variables stay in the configured domains; delivered requests were started |
| `OwnedWork` | A canceled downstream execution has no pending timer or active request |
| `SelectedInner` | Every active request has been started |
| `FreshEmission` | No result from an older raw notification has been emitted |
| `NeverDelivers` | Deliberately false property used to obtain a delivery witness |

The baseline structural configuration checks the first three invariants to
completion. Its freshness configuration must find a `FreshEmission` violation.
The candidate configuration checks all four intended invariants to completion.
A separate candidate configuration must violate `NeverDelivers`, demonstrating
that delivery is reachable. That witness establishes reachability only; it
does not require every execution or request to make progress.

## The actual TLC counterexample

The pinned checker run on 2026-10-30 produced the following baseline trace.
Tick-only states are omitted; the TLC state numbers retain their original gaps.

| TLC state | Virtual time | Event | Baseline state after the reaction | Observable action |
|---:|---:|---|---|---|
| 1 | 0 | `Init` | `latestRaw=0`, `pending=0`, `active=0` | No request |
| 2 | 0 | `Query 1` | `latestRaw=1`, `pending=1`, `active=0` | Set deadline 3 |
| 6 | 3 | `Timer 1` | `latestRaw=1`, `pending=0`, `active=1` | Subscribe request 1 |
| 8 | 4 | `Query 2` | `latestRaw=2`, `pending=2`, `active=1` | Set deadline 7; request 1 remains subscribed |
| 9 | 4 | `Result 1` | `latestRaw=2`, `pending=2`, `active=0` | Emit request 1's result and complete its inner subscription |

The two events at time 4 are separate, ordered reactions: query 2 arrives first,
then request 1 delivers. This satisfies the timer-boundary restriction: the first
timer fired at time 3, and the next deadline is time 7. The last state violates
`FreshEmission` because result ID 1 differs from latest raw notification ID 2.

[`scripts/check-models.mjs`](../../scripts/check-models.mjs) decodes this checker
output and replays its external events through
[`replaySearchTrace`](../../runtime/replay-search-trace.mjs). It asserts that the
baseline's request IDs, request start times, and output IDs and times agree with
the TLC trace, and that the same freshness property fails in RxJS.

For the same external trace, the candidate unsubscribes request 1 when query 2
arrives at time 4. The subsequent result attempt is recorded as ignored because
its subscription is closed. No result is emitted in this prefix. The replay ends
at time 4, before query 2's timer is due. A separate runtime test continues a
longer trace through query 2's request start at time 7 and result delivery at
time 8, checking that the candidate can still return the current result.

## Bounds and assumptions

| Item | Scope of the checked search models |
|---|---|
| Runtime dependency | RxJS `7.8.2` |
| Query domain | At most two raw notifications, assigned distinct IDs 1 and 2 |
| Delay | 3 virtual time units |
| Horizon | Integer times 0 through 9; later work is outside the observation window |
| Ownership | One downstream execution; at most one active request and one pending wait |
| Inputs | Ordered, non-reentrant reactions; multiple external events may share a time when no timer fires there |
| Timer boundaries | External events cannot occur at a pending timer's deadline or elsewhere in the frame in which that timer fires |
| Request result | One `next` immediately followed by successful inner completion |
| Downstream termination | Explicit unsubscription is modeled |
| Progress | Safety and a delivery-reachability witness; no fairness or eventual-completion claim |

The timer-boundary restriction also excludes synchronous request results during
subscription: a `Result` cannot occur in the same frame as `Timer`. Source
completion, source errors, inner errors, multi-value requests, reentrant delivery,
throwing observers or teardown, and sharing across subscribers are outside this
TLA+ model. The search factory is modeled as a function of the notification ID;
its side effects and dependence on a projection index are outside the mapping.

The replay uses one live `Subject` for raw queries, one downstream subscriber,
and a cold `Observable` for each request. The pipeline helpers themselves retain
the subscription behavior of their supplied source and request factory. The
clock is RxJS `TestScheduler` virtual time, with one unit per frame. These checks
make no wall-clock latency or browser-event-loop guarantee.

All external replay events are enqueued in their supplied order before the
scheduler flushes. Equal-frame external events therefore precede timers that
those events schedule later. The model avoids that timer-tie case. Separate
runtime tests characterize both enqueue orders for a raw query and timer sharing
a frame; they extend the runtime evidence without extending the model's scope.

## Completion and error behavior outside the model

The candidate changes source-completion timing as well as cancellation timing.
When the source completes during a pending silence wait, `debounceTime` flushes
the cached query immediately. The candidate's selected timer retains its
scheduled deadline, and the outer `switchMap` waits for that timer/request flow
to finish.

For a query at time 0, source completion at time 1, delay 3, and a request result
at time 4, the runtime tests check:

| Observation | Baseline | Candidate |
|---|---:|---:|
| Request subscription starts | 1 | 3 |
| Result is delivered | 4 | 4 |
| Downstream completes | 4 | 4 |

This distinction matters when choosing a pipeline for a source that can complete.
Source completion preserves the selected inner's opportunity to finish. Direct
runtime tests also check that a source error discards waiting input or closes an
active request, and that downstream cancellation prevents subsequent work.

The replay tests check that attempted queries after source completion cannot
change the last accepted query ID, and that explicit result payloads such as
`null` are preserved. These are adapter checks separate from the TLA+ properties.

## Reproduce the checks

Run from the repository root with Node 22 or later and Java 11 or later:

```sh
npm ci
npm run setup:tlc

# Run this experiment's four TLC cases and the counterexample replay.
npm run verify:models -- search-structure search-debounced search-immediate search-delivery-witness

# Run all runtime and checker-classification tests.
npm test

# Run all registered TLC experiments followed by the runtime test suite.
npm run verify
```

`setup:tlc` downloads and verifies the SHA-256-pinned official TLA+ tools `v1.7.4`
JAR, which reports TLC `2.19`. The model runner uses breadth-first exploration,
one worker, fixed fingerprint and exploration seeds, and a fresh metadata
directory for each case. The finite horizon is part of the search specification.

The negative cases count as successful checks only when TLC exits with code 12
and names the intended violated invariant. A parser error, missing Java,
timeout, or another invariant failure fails the command. Positive cases require
exit 0 and TLC's explicit successful-completion message.

The runner writes raw logs, a report containing source hashes, and decoded
counterexample/replay evidence under `artifacts/`. A selected-case run records
the selected cases in `model-results.json`. Check that report's timestamp and
input hashes when comparing it with a later working tree.

### Independently reproduced results: 2026-10-30

| Experiment ID | Expected result | Generated states | Distinct states | States left on queue |
|---|---|---:|---:|---:|
| `search-structure` | Completed successfully; exit 0 | 1,315 | 750 | 0 |
| `search-debounced` | `FreshEmission` violation; exit 12 | 139 | 101 | 23 |
| `search-immediate` | Completed successfully; exit 0 | 1,054 | 619 | 0 |
| `search-delivery-witness` | `NeverDelivers` violation; exit 12 | 107 | 78 | 18 |

The negative runs stop when the requested counterexample is found, leaving work
on the queue. The positive runs exhaust their configured reachable state graphs.
The baseline counterexample's request starts and emitted results were also
independently matched against RxJS, and the candidate suppressed the stale
delivery for that same external trace.

Review the mapping and assumptions when changing the pipelines, dependency,
scheduler profile, or model parameters. A green run checks the supplied finite
model and runtime assertions; it does not establish a general theorem about
all RxJS pipelines or all JavaScript executions.
