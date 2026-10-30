# Experiment 03: run the same TLA+ model with `tla-ts` and TLC

## Intuition

The operator description and the property should stay the same when we try a
different checker. This experiment reads all 31 cases from the root
`experiments.json` and gives the existing `Take.tla`, `SearchFreshness.tla`,
`SearchLifecycle.tla`, and `RequestProtocol.tla` models and their configurations
to both the official TLC checker and the JavaScript package `tla-ts`. It compares
their results without copying or translating the models.

This is useful for learning whether our small TLA+ experiments can also run
inside the JavaScript toolchain used by our RxJS work.

## What `tla-ts` provides

[`aidenybai/tla-ts`](https://github.com/aidenybai/tla-ts) implements a TLA+
interpreter and model checker in TypeScript. Its public `check` API accepts TLA+
source text and a TLC configuration. It returns a structured verdict, state
counts, and counterexample traces.

It does not take an arbitrary TypeScript reducer or RxJS pipeline and derive a
TLA+ model. Our Mealy-to-TLA+ correspondence remains a separate task. The same
model/code correspondence limits apply to both checkers.

The inspected upstream source documents safety and temporal-property checking,
including weak and strong fairness, and contains liveness tests compared with TLC
verdicts. Those capabilities are outside this laboratory's current validation:
the 31 configurations check safety properties, reachability witnesses, and deliberate model mutations. The proof command can generate obligations
or invoke an independently installed `tlapm`; the package does not include its
own theorem prover.

An asynchronous JavaScript API or worker-thread execution does not automatically
model JavaScript event-loop ordering, RxJS schedulers, sharing, or reentrancy.
Those behaviors still need to be represented in the TLA+ specification.

## Dependency and source record

| Item | Record |
|---|---|
| Inspected upstream commit | `660addc663da3231d3df70d09fc4f1803bad97a6` |
| Package used for this execution | Published npm `tla-ts@0.0.3` |
| Package integrity | SHA-512, recorded below and in this directory's `package-lock.json` |
| License | MIT; upstream copyright Aiden Bai, 2026 |
| Official comparison checker | TLA+ tools release `v1.7.4`, reporting TLC `2.19` |
| Input models | Existing modules and configurations named by the root `experiments.json` |
| Dependency isolation | Local to this experiment; root dependencies are unchanged |

The npm metadata did not provide a `gitHead`. The inspected source revision and
the executed npm artifact are recorded separately; matching version strings do
not establish that the published artifact equals that Git commit.

The pinned npm tarball integrity is:

```text
sha512-y5wQZRGMqjc+47BHRZ3I+Re7O1bFSWlNX+835pZkdPzVRPkgQeTlKERPsPcuI1fMGf2Av4Gx8K3n3NnPAAUUBg==
```

Primary source paths at the inspected revision:

- [README and public API](https://github.com/aidenybai/tla-ts/blob/660addc663da3231d3df70d09fc4f1803bad97a6/README.md)
- [Package manifest](https://github.com/aidenybai/tla-ts/blob/660addc663da3231d3df70d09fc4f1803bad97a6/packages/tla-ts/package.json)
- [Checker options and results](https://github.com/aidenybai/tla-ts/blob/660addc663da3231d3df70d09fc4f1803bad97a6/packages/tla-ts/src/check.ts)
- [JavaScript API and worker selection](https://github.com/aidenybai/tla-ts/blob/660addc663da3231d3df70d09fc4f1803bad97a6/packages/tla-ts/src/parallel.ts)
- [Temporal-property implementation](https://github.com/aidenybai/tla-ts/blob/660addc663da3231d3df70d09fc4f1803bad97a6/packages/tla-ts/src/liveness.ts)
- [Liveness test cases](https://github.com/aidenybai/tla-ts/blob/660addc663da3231d3df70d09fc4f1803bad97a6/packages/tla-ts/tests/unit/liveness.test.ts)
- [License](https://github.com/aidenybai/tla-ts/blob/660addc663da3231d3df70d09fc4f1803bad97a6/LICENSE)

## Run the comparison

From the repository root, with root RxJS dependencies, Java, and the documented
TLC JAR available:

```sh
npm ci --ignore-scripts --no-audit --no-fund --prefix experiments/03-tla-ts
node experiments/03-tla-ts/compare.mjs
```

The script uses one worker and seed zero in both checkers, and TLC's `-fp 0`.
It verifies the root toolchain's TLC checksum and reads each model and
configuration directly. Each official TLC invocation has a fresh temporary
metadata directory and a 30-second timeout.

The comparison passes only if:

1. Every case has the verdict declared in the shared experiment manifest.
2. Both checkers identify each negative case's exact invariant declared in the
   manifest, including the deliberately false lifecycle and request-protocol witness invariants.
3. Generated-state counts, distinct-state counts, and search depths agree for
   every configuration.
4. The structured `FreshEmission` trace reproduces request starts, output times,
   and the stale-result violation in real RxJS; the immediate-cancellation
   candidate suppresses the stale delivery for the same external trace.
5. Seven additional structured lifecycle traces match real RxJS request starts,
   stops and stop reasons, emitted values, terminal notifications, and final
   settled source/destination lifecycle and ownership.
6. Eight structured request-protocol traces match accepted independent inner
   `N`/`C`/`E` notifications, ordered output positions, request value counts,
   starts/stops and reasons, freshness, and final settled ownership.

Unexpected exceptions, other invariant failures, and count differences fail the
comparison. A deliberate mutation is an expected negative case, not an error to
hide.

## Initial recorded evidence: seven configurations

Both checkers agreed on all seven unchanged cases:

| Manifest case | Verdict in both checkers | Generated | Distinct | Depth |
|---|---|---:|---:|---:|
| `take-two` | Success | 30 | 17 | 4 |
| `take-zero` | Success | 3 | 2 | 2 |
| `take-mutant` | `QuotaBound` violation | 21 | 18 | 5 |
| `search-structure` | Success | 1,315 | 750 | 17 |
| `search-debounced` | `FreshEmission` violation | 139 | 101 | 9 |
| `search-immediate` | Success | 1,054 | 619 | 17 |
| `search-delivery-witness` | `NeverDelivers` violation | 107 | 78 | 8 |

The official checker exited with `0` for positive cases and `12` for the named
negative cases. The initial comparison script exited with `0` because all expected
outcomes, counts, and replay assertions agreed. This seven-case snapshot remains
historical evidence in
[`verification/evidence/tla-ts-results.json`](../../verification/evidence/tla-ts-results.json).

### Structured counterexample replay

`tla-ts` returns `violation.trace` as state objects. The adapter reads scalar
fields such as `now`, `lastEvent`, and `lastId` directly. It maps the ordered
external events into the existing `runtime/replay-search-trace.mjs`; the replay
does not parse TLC's console text. The comparison still reads the official
checker's console to compare counts and verdicts.

The counterexample has this sequence, omitting clock-advance-only states:

| Virtual time | Event | Observed consequence |
|---:|---|---|
| 0 | Query 1 | Start a three-frame silence wait |
| 3 | Timer | Subscribe to request 1 |
| 4 | Query 2 | Start the next silence wait; the baseline still has request 1 |
| 4 | Result 1 | Baseline emits a result for query 1 after accepting query 2 |

The two events at time 4 remain distinct ordered events. They do not tie with a
timer deadline in this model. The immediate-cancellation candidate closes
request 1 at query 2 and suppresses its attempted result. This trace demonstrates
the chosen freshness property under the experiment 02 scope; it is not a claim
that the baseline violates RxJS's `switchMap` contract.

This initial run is evidence of agreement on two small RxJS-related safety models. It is not a
benchmark, a proof of general TLC compatibility, a liveness validation, or proof
that the model describes every implementation behavior. No claim about the
upstream project's advertised performance is inferred from these runs.

## Lifecycle extension: 18 configurations and seven additional replays

[Experiment 04](../04-search-lifecycle/README.md) adds eleven configurations while
preserving the original seven. Four complete safety explorations combine the two
pipeline policies with `external-first` and `timer-first` frame profiles. The
remaining seven configurations produce one freshness counterexample and six
reachability witnesses:

| Structured lifecycle trace | Interpretation |
|---|---|
| `FreshEmission` | Debounced selection can still deliver an old result after a newer raw query |
| `NoCompletionFlush` | Completing the source flushes a pending debounced query into a request |
| `NoDeferredCompletion` | Immediate selection can retain its final timer after source completion |
| `NoSourceErrorDiscard` | A source error discards pending input without flushing it |
| `NoInnerError` | An active request error propagates and releases owned work |
| `NoBoundaryStart` | A request can start before a new query arrives at the same integer frame |
| `NoResultCompletion` | An immediate-policy result can emit and complete the destination after source completion |

The six deliberately false witness invariants reveal reachable behavior; their
violations do not classify the implementation as defective. The freshness
counterexample violates the separately stated latest-raw-query requirement.
The corresponding positive configurations preserve that requirement for the
immediate policy under both profiles.

The lifecycle adapter keeps source completion separate from destination
completion. A final timer/request may continue after the source has ended. A
source error instead discards pending input and closes an active request; an
active request error also unsubscribes a still-open source. Cancellation emits no
terminal notification. At a shared deadline, external-first can prevent a
request subscription entirely, while timer-first can permit a transient
subscription that is canceled within the same frame. Comparing output values
alone would miss that resource distinction.

The comparison maps structured states through the shared lifecycle evidence
adapter into [`replayLifecycleTrace`](../../runtime/replay-lifecycle-trace.mjs).
It checks actual RxJS request starts/stops and reasons, notifications, freshness,
source/destination state, and settled subscription ownership. The original
experiment 02 replay is retained. In this `tla-ts` comparison, lifecycle replay
does not parse the official checker's console trace; console parsing remains necessary for the differential
comparison of TLC's reported verdicts and state counts.

Fresh runs write `artifacts/tla-ts-results.json`, including configuration/model
hashes, the original freshness replay, and the seven lifecycle replays. The
expanded archived run is recorded in the
[lifecycle-extension evidence](../../verification/evidence/lifecycle-extension/README.md),
with its [checker results](../../verification/evidence/lifecycle-extension/tla-ts-results.json),
[official model results](../../verification/evidence/lifecycle-extension/model-results.json),
and [verification log](../../verification/evidence/lifecycle-extension/verification.log).
Use that snapshot's hashes and executed outcomes when assessing the lifecycle
extension; the earlier seven-case table remains an initial result.

Experiment 04 fixes delay 2, integer time 0 through 4 and at most two query
notifications. Its two profiles group external actions before or after due timer
work. It excludes synchronous/reentrant request emissions, multi-value or
empty-completing request protocols, fractional/zero-delay scheduling, arbitrary
within-frame interleavings, sharing and liveness. Additional runtime fixtures do
not enlarge these model bounds. Agreement between the checkers and the selected
replays remains scoped evidence, not a proof of general checker equivalence or
of all RxJS implementation behavior.

## Request protocol extension: 31 configurations and eight additional replays

[Experiment 05](../05-request-protocol/README.md) adds thirteen configurations
while preserving the earlier eighteen. Four positive configurations combine the
two search policies with both timer-order profiles. Eight configurations produce
one freshness counterexample and seven reachability witnesses. A final model
mutation deliberately closes a request on its first `next` and must violate
`NextKeepsRequestActive`.

| Structured request-protocol trace | Interpretation |
|---|---|
| `FreshEmission` | Debounced selection can forward an old request's value after a newer raw query |
| `NoMultipleValues` | One request can deliver two independent values and remain active |
| `NoEmptyCompletion` | A request can complete the destination without delivering any value |
| `NoNextAfterSourceComplete` | A value can arrive after source completion while the destination remains open |
| `NoMultiValueCompletion` | A separate inner completion can finish the destination after multiple values |
| `NoNextThenError` | An error can end a request after an already-delivered value |
| `NoSwitchAfterValue` | A new raw query can cancel a request after some of its values |
| `NoCancelAfterValue` | Downstream cancellation can release a partly delivered request without a terminal notification |

`InnerNext` preserves ownership. `InnerComplete` emits no value. `InnerError`
does not retract the already-delivered prefix. These actions retain source
completion and downstream completion as separate states. The model uses opaque
notification positions `(request ID, index)` to observe order and multiplicity;
the payload contents remain outside its abstraction.

The bounds are at most two query notifications, two accepted values per request,
delay 2, and integer frames 0 through 4. There is one subscriber and the same
external-first/timer-first scheduler profiles as experiment 04. Requests may
remain open at the horizon; no fairness or eventual-termination guarantee is
inferred. Synchronous subscription emissions, reentrant observers, arbitrary
within-frame interleavings, fractional/zero-delay timing, and sharing remain
outside the model.

The comparison maps structured states through
[`request-protocol-evidence.mjs`](../../scripts/request-protocol-evidence.mjs)
into [`replayRequestProtocol`](../../runtime/replay-request-protocol.mjs), which
uses the unchanged RxJS pipeline functions. Official TLC's scalar-text traces
go through the same correspondence checks in the model runner. Both paths check
the request protocol and settled ownership rather than only downstream values.
The verification includes the original freshness replay, seven lifecycle
replays, and eight request-protocol replays from each checker.

The `CompleteOnNext` configuration is an intentional model defect and is not
replayed as if it described the correct runtime. A separate
`npm run verify:protocol-mutation` drill inserts `take(1)` into the actual
immediate-policy pipeline in a disposable copy and requires an independent
runtime test to fail. The two defects share premature closure but have different
teardown: `take(1)` unsubscribes the request, while `CompleteOnNext` synthesizes
request completion. Checker agreement on the model mutant does not establish
that the implementation mutation is faithfully modeled.

The [request-protocol evidence](../../verification/evidence/request-protocol/README.md)
records this source snapshot's executed outcomes separately from the two older
snapshots. Fresh runs write all 31 results and the three groups of trace replays
to `artifacts/tla-ts-results.json`; the comparison requires exact agreement on
verdicts, named violations, generated/distinct state counts, and depths. These
are correctness checks for the configured inputs, not performance benchmarks or
general equivalence claims about the checkers.

## Use in this laboratory

Retain official TLC as the reference checker while using `tla-ts` as an optional
second implementation and a route to structured JavaScript trace tools. This
experiment retains the initial search counterexample adapter and extends the
structured interface to lifecycle, independent request notifications, and
subscription-ownership traces.
Future browser presentation, BDD rendering, or four-lane diagrams could consume
the same structured states. No general TypeScript model compiler or automatic
RxJS verifier is introduced here.
