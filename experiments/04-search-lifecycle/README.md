# Experiment 04: completion, errors and timer-boundary ordering

## Intuition

Experiment 02 made the cancellation boundary explicit. This experiment asks what
happens when the source ends, an error arrives, or a new query shares a timer's
deadline. It adds those behaviors in a separate model so that the first model's
narrower assumptions and recorded evidence remain available.

Two distinctions matter:

1. **The source can be complete while the destination remains open.** A final
   timer or request may still be owned by the pipeline.
2. **Equal timestamps do not determine event order.** A request can start and be
   canceled in one frame, producing no value but still acquiring a resource.

The two pipeline functions are unchanged:

```js
queries$.pipe(debounceTime(delay, scheduler), switchMap(search));

queries$.pipe(
  switchMap(query => timer(delay, scheduler).pipe(
    switchMap(() => search(query))
  ))
);
```

### Completion has two different contracts

For query 1 at frame 0, source completion at frame 1, and delay 2:

| Policy | Request 1 starts | What destination completion waits for |
|---|---:|---|
| Debounced selection | Frame 1: source completion flushes the pending query | The selected request's completion |
| Immediate selection | Frame 2: the selected timer keeps its deadline | The timer and then the selected request |

If a request emits its one result and completes at frame 3, both destinations
produce that result and then complete at frame 3. The policies differ in when
they acquire the request. Source completion without pending or active work
completes the destination immediately.

An error has a different reaction: source error discards any pending query,
closes an active request and emits an error. An active request's error closes the
destination and unsubscribes a still-open source. Downstream cancellation closes
owned work without emitting a terminal notification.

### A boundary can hide a transient subscription

For query 1 at frame 0, query 2 at frame 2, and delay 2:

| Frame-2 order | Immediate-selection request behavior |
|---|---|
| External input before the due timer | Query 2 cancels the wait; request 1 never starts |
| Due timer before external input | Request 1 starts, then query 2 immediately unsubscribes it at the same frame |

Both profiles remain fresh under the modeled immediate policy. The transient
request is visible in subscription records even when there is no downstream
`next`. A source error or cancellation at a timer deadline can have the same
start-then-stop distinction. Observable cancellation guarantees the subscription
is closed; physical transport abort depends on that Observable's teardown.

## Specification

[`SearchLifecycle.tla`](SearchLifecycle.tla) uses independent `sourceState` and
`destinationState`, a pending query and deadline, an active request ID, and
monotonic sets of started, stopped and delivered request IDs. IDs identify query
notifications, including repeated search text as separate notifications.

| Model action | Real RxJS reaction represented |
|---|---|
| `Query` | Accept raw input; replace pending wait; immediate policy also closes the selected request |
| `Timer` | Select and subscribe the pending request; replace an older active request if necessary |
| `Result` | One request `next`, immediately followed by successful inner completion |
| `SourceComplete` | Stop accepting source input; baseline flushes pending selection, immediate policy preserves its wait |
| `SourceError` | Discard the wait, close owned request, send one downstream error |
| `InnerError` | Error the destination, close its work, unsubscribe a still-open source |
| `Cancel` | Close source, timer and request ownership without a downstream terminal notification |

Each action is observed after its non-reentrant reaction settles. Callback and
teardown micro-order inside an action is not modeled. For example, an error
callback can run before every teardown callback, while the settled state owns no
remaining work.

### Explicit scheduler profiles

Every integer frame has an external phase and a timer phase:

- **`external-first`:** ordered external events, then any still-due timer.
- **`timer-first`:** any due timer, then ordered external events.

The environment nondeterministically chooses the valid external events and their
order within the external phase. Moving to the next frame requires both phases
to finish. A due timer cannot be skipped. At the finite horizon, the model
stutters only after the final frame has settled; a timer whose deadline is after
the horizon can remain pending.

The [runtime adapter](../../runtime/replay-lifecycle-trace.mjs) realizes these
profiles using RxJS's actual `TestScheduler`. External-first enqueues external
events before flushing. Timer-first enqueues each external event at frame `t`
from a wrapper at `t - 0.5` (or frame 0 for initial input), after a relevant
integer-frame timer has been created or rearmed. The wrapper produces no source
notification. This relies on positive integer delays and integer input times;
it is a concrete scheduling profile for these pipelines, not a general model of
all JavaScript event-loop behavior.

The model abstracts `debounceTime`'s earlier timer wakeups that only rearm a later
deadline. Those wakeups have no selected-request or downstream-output effect in
this observation vocabulary. The runtime tests exercise a rearmed deadline under
both profiles.

### Invariants

| Invariant | Requirement |
|---|---|
| `TypeOK` | Finite state domains, valid resource sets, and at most one counted terminal notification |
| `OwnedWork` | A closed destination retains no active request or pending timer |
| `PendingClock` | A pending query exists exactly when a deadline exists |
| `ActiveAccounting` | Started requests not yet stopped equal the one active request, or the empty set |
| `SourceOwnership` | A closed destination does not retain an open source |
| `TerminalProtocol` | A completed/errored destination has exactly one terminal notification; open/cancelled destinations have none |
| `CompletionAgrees` | Completion requires source completion; a completed source with no remaining work cannot leave the destination open |
| `ErrorAgrees` | Source error reaches the destination as error |
| `ErrorReaction` | An error reaction starts no request, emits no `next`, and emits an error terminal |
| `FreshEmission` | Each emitted result belongs to the latest accepted raw-query notification |

The terminal count increments on every modeled terminal emission. It is not a
Boolean flag that would hide an accidental second emission. Freshness is checked
for both immediate-policy profiles. The debounced model also has a targeted
freshness counterexample configuration, preserving the requirement while exposing
the baseline's behavior.

Sticky flags and the last reaction's observations support deliberately false
invariant checks:

| False invariant | Reachable behavior it witnesses |
|---|---|
| `NoCompletionFlush` | Source completion flushes a pending debounced query into a request |
| `NoDeferredCompletion` | Immediate selection retains a pending timer after source completion |
| `NoSourceErrorDiscard` | Source error discards a pending query |
| `NoInnerError` | An active inner error propagates and releases ownership |
| `NoBoundaryStart` | A new query follows a request start at the same frame in the timer-first profile |
| `NoResultCompletion` | An immediate-policy request emits its result and then completes the destination after source completion |

`NoBoundaryStart` is a passing safety property for the external-first profiles.
`NoCompletionFlush` is a passing property for the immediate profiles. Their
counterpart failures show that the modeled distinctions are reachable. These
witnesses are existence checks; they are not eventual-delivery or fairness
properties.

### Bounds and exclusions

Every configuration fixes delay **2**, integer frames **0 through 4**, and at most
**two distinct query notification IDs**. There is one subscriber, at most one
pending wait and at most one active request. A request can emit once and then
complete, or error. Pending work can extend beyond the observation horizon.

The model includes only accepted source events and active-request events.
Attempts after termination, a result attempted before subscription, and errors
from canceled requests are ignored by the runtime adapter and tested separately.
They do not introduce model transitions. Sequential external events can occur at
the same integer frame, but requests do not emit synchronously during their
subscription callback.

Not covered: reentrant observers, throwing callbacks/teardown, multi-result or
empty-completing requests, fractional/zero/negative delays, arbitrary interleaving
of timer and external actions within a frame, multiple subscribers, sharing,
unbounded time, physical network cancellation, fairness or liveness.

The source behavior was inspected in the pinned RxJS 7.8.2 implementation:
[`debounceTime`](https://github.com/ReactiveX/rxjs/blob/e5351d02e225e275ac0e497c7b66eaa5f0c88791/src/internal/operators/debounceTime.ts),
[`switchMap`](https://github.com/ReactiveX/rxjs/blob/e5351d02e225e275ac0e497c7b66eaa5f0c88791/src/internal/operators/switchMap.ts),
[`timer`](https://github.com/ReactiveX/rxjs/blob/e5351d02e225e275ac0e497c7b66eaa5f0c88791/src/internal/observable/timer.ts), and
[`VirtualTimeScheduler`](https://github.com/ReactiveX/rxjs/blob/e5351d02e225e275ac0e497c7b66eaa5f0c88791/src/internal/scheduler/VirtualTimeScheduler.ts).

## Verification

From the repository root:

```sh
npm run verify:models
node --test tests/search-lifecycle.test.mjs
npm run verify:tla-ts
```

The root manifest supplies all eleven configurations to both checkers. The positive
configurations require a completed successful exploration; negative cases must
fail the exact intended invariant. Parser errors, crashes, unrelated violations
and timeouts fail the verification command.

Official TLC's final runs produced:

| Configuration | Required outcome | Generated | Distinct | Depth |
|---|---|---:|---:|---:|
| `debounced-external.cfg` | Pass | 1,156 | 829 | 21 |
| `debounced-timer.cfg` | Pass | 1,884 | 1,323 | 22 |
| `immediate-external.cfg` | Pass | 1,048 | 768 | 21 |
| `immediate-timer.cfg` | Pass | 1,561 | 1,126 | 22 |
| `debounced-freshness.cfg` | `FreshEmission` violation | 392 | 297 | 14 |
| `completion-flush-witness.cfg` | `NoCompletionFlush` violation | 8 | 8 | 3 |
| `completion-wait-witness.cfg` | `NoDeferredCompletion` violation | 8 | 8 | 3 |
| `source-error-witness.cfg` | `NoSourceErrorDiscard` violation | 9 | 9 | 3 |
| `inner-error-witness.cfg` | `NoInnerError` violation | 181 | 155 | 11 |
| `boundary-witness.cfg` | `NoBoundaryStart` violation | 177 | 151 | 11 |
| `result-completion-witness.cfg` | `NoResultCompletion` violation | 213 | 180 | 12 |

The four completed safety explorations end with an empty state queue. The seven
counterexample runs stop at the named violation; their counts are not the entire
reachable state graph.

The result/completion witness prevents an immediate-policy freshness check from
passing solely because that policy never emits. Its actual trace reaches a
`Result` reaction with an output and downstream `C`, preserving their order.
This is a reachable successful completion, not an eventual-completion guarantee.

### Trace correspondence

The model records each reaction's `lastStartedId`, `lastStoppedId`,
`lastStopReason`, `lastOutputId` and `lastTerminal`, alongside `now`, `lastEvent`,
`lastId`, source/destination state and ownership. Control-only phase/tick actions
reset the reaction observations. This prevents repeated observations from being
mistaken for new subscriptions or notifications when rendering a trace.

The external events are replayed against the unchanged real RxJS pipeline
functions. A successful comparison must preserve event order and match request
starts, request stops and their reasons, outputs, terminal notifications, and the
final settled source/destination state. Lifecycle counterexamples are chosen so
their final state remains stable through the rest of that integer frame. This
allows the runtime scheduler to finish the frame without confusing a partial
phase prefix with the model's observed state.

Counterexample replay is selected runtime evidence. Even exact agreement on these
traces and between the two checkers does not prove that every possible RxJS
execution refines the model. See the root [verification evidence](../../verification/evidence/)
for source hashes and complete recorded outcomes.
