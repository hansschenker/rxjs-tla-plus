# Experiment 05: independent request notifications

## Intuition

A search request is a stream. It can deliver several values over time, complete
without a value, fail after earlier values, or remain open. Receiving a value
does not by itself end the request.

Experiment 04 represented a successful request with one atomic `Result` action:
one `next` immediately followed by `complete`. This experiment separates those
notifications into `InnerNext`, `InnerComplete`, and `InnerError`. The earlier
model and its evidence remain available unchanged.

The same two search pipelines are used. One selects a request after
`debounceTime`; the other uses an outer `switchMap` to cancel the currently
selected timer or request on every accepted raw query. Values and errors come
from the request source. Timer deadlines and their ordering come from the
scheduler. A single pipeline subscription is established before frame 0; each
request starts its own execution when selected and subscribed. There is no
sharing or second subscriber in this experiment.

### A value keeps the request alive

The new actions have distinct effects:

| Incoming request notification | What flows downstream | Request after the reaction |
|---|---|---|
| `next(value)` | That value | Still active |
| `complete()` | No new value; possibly downstream completion | Closed successfully |
| `error(error)` | Downstream error | Closed with error; remaining owned work released |

The destination may complete on inner completion only when the source is already
complete and no pending selection remains. If the source is still open, inner
completion leaves the pipeline waiting for another query.

The complete source does not prevent the selected request from continuing to
deliver values. Here is the actual multi-value completion witness produced by
TLC for immediate selection with timer-first ordering:

| Frame | Event | Destination notification | Active request afterwards |
|---:|---|---|---|
| 0 | Query 1 | None | None; timer pending |
| 0 | Source completes | None | None; timer still pending |
| 2 | Timer selects request 1 | None | Request 1 |
| 2 | Request 1 next #1 | Value #1 | Request 1 |
| 2 | Request 1 next #2 | Value #2 | Request 1 |
| 2 | Request 1 completes | Complete | None |

Several events can share a frame while retaining their sequence order. The
model also explores actions in different frames. The trace above establishes a
reachable behavior; it does not promise that every request eventually completes.

### Empty completion is a useful behavior

The empty-completion witness follows the same query/source-completion/timer
prefix and then directly performs `InnerComplete`. The destination receives
completion without receiving a value. Completion therefore cannot be inferred
from a final value: a final value may not exist.

An error after a value is also allowed. Earlier values remain part of the output
history; the later error terminates that history. Cancellation and replacement
close the old subscription without inventing an inner completion notification.
Attempts to deliver more notifications through that closed subscription are
ignored by real RxJS and checked in the runtime tests.

### Freshness applies to every value

Each forwarded value must belong to the latest accepted raw-query notification.
An earlier value from a request can be fresh while a later value from the same
request would be stale after new raw input. Immediate selection closes that
request on the new query. Debounced selection can keep it active until the new
query is selected and therefore retains a freshness counterexample.

The existing completion distinction also remains: source completion flushes a
pending debounced query, whereas immediate selection keeps its selected timer's
deadline. If debounced selection has an old active request and a newer pending
query, the old request's completion leaves the pending query intact. An error
from the old active request terminates the pipeline and discards that pending
query.

## Specification

[`RequestProtocol.tla`](RequestProtocol.tla) retains the lifecycle model's
independent source/destination state, pending timer, active request, and explicit
frame phases. It adds per-request notification counts, ordered value histories,
and separate sets of requests closed by completion, error, or cancellation.

### Event and action policy

| Model action | Settled reaction |
|---|---|
| `Query` | Accept a raw query and replace its pending wait; immediate policy also cancels the selected request |
| `Timer` | Subscribe the pending request, cancelling an older request if necessary |
| `InnerNext` | Forward one value and keep the request active |
| `InnerComplete` | Close the request; complete the destination only after source completion and with no pending work |
| `InnerError` | Error the destination and release source, timer, and request ownership |
| `SourceComplete` | Stop accepting queries; flush or preserve pending selection according to policy; wait for remaining work |
| `SourceError` | Discard pending selection, cancel active work, and error the destination |
| `Cancel` | Close owned subscriptions without a downstream terminal notification |

Request IDs identify query notifications rather than search-text equality. A
value notification has the opaque identity `<<requestId, ordinal>>`, where its
ordinal starts at 1 for that request. The model does not inspect value contents.
`acceptedNexts` and `outputHistory` are sequences, so two values from one request
remain separate observations and their order can be checked. Equal application
payloads are still distinct notifications. Actual payload forwarding is checked
independently in the RxJS tests.

`nextCounts` remembers how many values each started request has delivered.
`activeNextCount` exposes the selected request's count, or zero when none is
active. `lastOutputIndex` identifies the output notification within its request.
The other scalar observations retain the lifecycle trace vocabulary. Phase and
clock transitions reset those observation fields to avoid duplicate effects in
decoded traces.

### Requirements

| Invariant | Requirement |
|---|---|
| `TypeOK` | Finite domains, bounded histories, valid resource sets, and at most one destination terminal notification |
| `OwnedWork`, `PendingClock` | Closed output owns no timer/request; pending input and deadline agree |
| `ActiveAccounting` | Started-but-not-stopped requests equal the selected request; its exposed next count agrees with the stored count |
| `RequestTermination` | Each stopped request belongs to exactly one completion/error/cancellation category |
| `SourceOwnership` | A closed destination does not retain an open source |
| `TerminalProtocol` | Completed/errored output has exactly one terminal notification; open/cancelled output has none |
| `ClosedOutputStable` | Value history cannot grow after destination closure |
| `CompletionAgrees` | Output completion requires source completion; a completed source with no remaining work cannot leave output open |
| `ErrorAgrees`, `ErrorReaction` | Source error reaches output; an error reaction emits no value and starts no request |
| `NextKeepsRequestActive` | A next notification retains its active request and does not emit a terminal notification |
| `CompleteDoesNotEmit` | Inner completion stops the addressed request and creates no value |
| `OutputAccounting` | Forwarded notification identities exactly equal accepted next notifications, including per-request counts |
| `OutputOrder` | Each request's values retain their ordinal order without duplication or gaps |
| `FreshEmission` | Every emitted value belongs to the latest accepted raw query |

Both policies satisfy the structural and notification-protocol requirements.
Freshness is required in the two immediate-policy safety configurations. A
separate debounced configuration preserves that requirement and exposes its
violation.

### Explicit time and finite scope

Every configuration fixes:

- **RxJS 7.8.2** for actual execution.
- **Two** query notification IDs and at most **two next notifications per
  request**.
- Delay **2**, integer frames **0 through 4**.
- One subscriber, at most one pending timer and one active request.
- Either **external-first** or **timer-first** ordering for each frame.

The per-request value limit is a model-search bound. It does not add a `take(2)`
policy to the runtime pipeline, force completion after two values, or claim that
real requests have that limit. `InnerComplete`, `InnerError`, cancellation, and
replacement remain possible after the value bound is reached. A request may
remain open at the horizon, including a request that has delivered no values.

Timer and external phases retain the experiment-04 profile: a frame cannot
advance while its due timer remains unhandled. A timer scheduled beyond the
horizon may remain pending. TLA+ stuttering is allowed and no fairness
assumption is added, so there is no eventual-delivery or eventual-completion
claim.

Only accepted source events and notifications from an active request are model
actions. Attempts before subscription or after completion, error, replacement,
or cancellation are runtime fixtures, not additional model transitions.

Still excluded: synchronous notifications during request subscription, reentrant
or throwing observers/teardown, fractional or zero delays, arbitrary mixed
timer/input ordering within one frame, multiple subscribers, sharing, physical
transport abort, and unbounded executions. These are the declared abstraction
boundaries, not conclusions about what RxJS can support.

## Verification

From the repository root:

```sh
npm run verify:models
node --test tests/request-protocol.test.mjs tests/request-protocol-evidence.test.mjs
npm run verify:tla-ts
```

The root manifest supplies these same model/configuration files to official TLC
and the optional `tla-ts` checker. Positive checks must finish successfully with
an empty exploration queue. Every negative must fail its exact named invariant;
syntax errors, crashes, timeouts, and unrelated violations fail the gate.

### Official TLC results

| Configuration | Required outcome | Generated | Distinct | Depth |
|---|---|---:|---:|---:|
| `debounced-external.cfg` | Pass | 3,123 | 2,112 | 25 |
| `debounced-timer.cfg` | Pass | 5,000 | 3,174 | 26 |
| `immediate-external.cfg` | Pass | 1,554 | 1,070 | 23 |
| `immediate-timer.cfg` | Pass | 2,731 | 1,777 | 26 |
| `debounced-freshness.cfg` | `FreshEmission` violation | 427 | 335 | 12 |
| `multiple-values-witness.cfg` | `NoMultipleValues` violation | 234 | 197 | 12 |
| `empty-completion-witness.cfg` | `NoEmptyCompletion` violation | 216 | 183 | 12 |
| `next-after-source-complete-witness.cfg` | `NoNextAfterSourceComplete` violation | 215 | 182 | 12 |
| `multi-value-completion-witness.cfg` | `NoMultiValueCompletion` violation | 418 | 349 | 14 |
| `next-then-error-witness.cfg` | `NoNextThenError` violation | 238 | 201 | 12 |
| `switch-after-value-witness.cfg` | `NoSwitchAfterValue` violation | 233 | 196 | 12 |
| `cancel-after-value-witness.cfg` | `NoCancelAfterValue` violation | 239 | 202 | 12 |
| `mutant-complete-on-next.cfg` | `NextKeepsRequestActive` violation | 178 | 152 | 11 |

The four positive runs explore their complete finite state graphs. Negative runs
stop at the intended violation; their counts do not describe the complete graph.

Seven deliberately false invariants witness multiple values while still active,
empty final completion, a value after source completion while output stays open,
final completion after two values, an error after a value, replacement after a
value, and cancellation after a value. These existence checks prevent key
protocol properties from passing merely because useful request behavior is
unreachable. They do not establish liveness.

### Actual RxJS correspondence

The [runtime adapter](../../runtime/replay-request-protocol.mjs) applies the
decoded external events to the unchanged search pipeline functions. It drives
the three inner notification methods independently and keeps request ownership
open after `next`. The [evidence helper](../../scripts/request-protocol-evidence.mjs)
accepts official TLC's scalar text observations or `tla-ts`'s structured states.

Correspondence compares accepted queries and inner notifications, output IDs and
ordinals, request start/stop times and reasons, each request's next count,
terminal notifications, freshness violations, and final source/destination
ownership. Actual payloads are independent of the model's notification labels.

All eight correct-model negative traces (the freshness counterexample plus seven
reachability witnesses) are replayed. Their selected endpoints are in the
timer-first external phase after the due timer has run, so the settled runtime
frame can be compared without hiding a remaining same-frame timer effect.

### Fault sensitivity

`CompleteOnNext = TRUE` is a deliberate model mutation. It treats an
`InnerNext` as successful request termination. The unchanged
`NextKeepsRequestActive` invariant rejects it on the first delivered value.
This model mutation is not a claim about actual RxJS behavior and is not
replayed as an expected correct execution.

Independent runtime checks must also reject premature termination. A runtime
defect that adds `take(1)` can close the underlying request by unsubscription,
whereas this model mutation records a completion. Those are complementary fault
checks, not identical mutant traces or evidence that their teardown reasons
match.

The [repository evidence](../../verification/evidence/) records reviewed source
hashes, complete verification outcomes, selected trace replays, and maintenance
drills. Agreement between two checkers and these selected RxJS executions does
not prove universal refinement of the implementation.
