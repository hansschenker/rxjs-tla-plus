# Lifecycle extension: reviewed execution evidence

Reviewed source: [`3704861ad442fb6d24f805f2e6e1cf4642f24431`](https://github.com/hansschenker/rxjs-tla-plus/commit/3704861ad442fb6d24f805f2e6e1cf4642f24431). The following publication commit adds evidence and synchronization notes without changing the 43 covered source files. This directory preserves the extension run separately from the [initial seven-case snapshot](../README.md).

## Executed gates

| Command | Actual outcome | Record |
|---|---|---|
| `npm run verify` | Source identity guard passed; all 18 expected TLC outcomes; all 40 named tests passed | [verification.log](verification.log), [model-results.json](model-results.json) |
| `npm run verify:tla-ts` | Both checkers agreed on all 18 verdicts, named violations, generated/distinct counts and depths; original freshness trace plus seven lifecycle traces replayed in RxJS | [tla-ts-results.json](tla-ts-results.json), [command log](tla-ts-command.log) |
| `npm run verify:mutation` | Drift detected, unchanged model passed, actual regression tests failed, aligned model violated unchanged freshness requirement | [maintenance-drill.json](maintenance-drill.json), [raw log](maintenance-drill.log) |

The 18 configurations comprise eight complete positive checks and ten required negative cases across three models. A negative case must fail the named invariant; an exception, timeout, parse error or unrelated violation fails the gate. Six new negatives are reachability witnesses and one is the debounced policy's freshness counterexample.

The runtime/harness suite has 22 original tests, 15 new lifecycle tests and three new correspondence-gate tests. One gate test deliberately feeds a completion-flush trace to the waiting policy and requires rejection. The 312 bounded `take` histories remain included in the original suite.

Recorded local tools: Node `24.22.1`, Java `17.0.20`, RxJS `7.8.2`, official TLA+ tools `v1.7.4` reporting TLC `2.19`, and published npm `tla-ts@0.0.3`. The workflow uses Node 22 and Java 17 on GitHub. Lockfiles and the toolchain checksum remain pinned.

## New complete safety explorations

| Pipeline policy | Frame order | Generated | Distinct | Depth |
|---|---|---:|---:|---:|
| Debounced selection | External first | 1,156 | 829 | 21 |
| Debounced selection | Timer first | 1,884 | 1,323 | 22 |
| Immediate selection | External first | 1,048 | 768 | 21 |
| Immediate selection | Timer first | 1,561 | 1,126 | 22 |

All four explorations completed with empty queues. The immediate-policy checks preserve freshness under both profiles. Both policies satisfy the configured ownership, terminal, completion and error invariants. External-first also rules out a raw query following a timer-started request within the same frame under this phase profile.

## Actual trace replays

The official-TLC path decodes scalar observations from its counterexample text. The `tla-ts` path consumes structured state objects. Both replay the same model vocabulary through the real RxJS functions, checking accepted inputs, request starts/stops and reasons, notifications, freshness violations, final source/output state, actual source ownership, destination closure and active request IDs.

| Trace | Meaning | Recorded table |
|---|---|---|
| Debounced freshness | An older request can emit after newer raw input | [lifecycle-debounced-freshness.md](replays/lifecycle-debounced-freshness.md) |
| Completion flush | Source completion can start the pending debounced request immediately | [lifecycle-completion-flush.md](replays/lifecycle-completion-flush.md) |
| Completion wait | A completed source can leave the immediate policy's timer alive | [lifecycle-completion-wait.md](replays/lifecycle-completion-wait.md) |
| Source error | Pending input is discarded without starting a request | [lifecycle-source-error.md](replays/lifecycle-source-error.md) |
| Inner error | An active request error terminates output and releases ownership | [lifecycle-inner-error.md](replays/lifecycle-inner-error.md) |
| Timer boundary | A request can start before raw input cancels it in the same frame | [lifecycle-boundary.md](replays/lifecycle-boundary.md) |
| Result and completion | The immediate policy can emit a result and complete after source completion | [lifecycle-result-completion.md](replays/lifecycle-result-completion.md) |

Each table has a neighboring JSON file containing full states, external events, expected observations and actual runtime records. The final witness establishes reachable output/completion, avoiding an entirely silent model; it does not establish eventual completion for every execution.

## Scope and provenance

Experiment 04 fixes delay 2, integer time 0 through 4, at most two query notifications and one subscriber. External events occur entirely before or entirely after due timers at each frame. Positive integer timing makes the runtime enqueue profiles valid, including debounce rearming. Requests have one result followed by completion or an error. Observations are after a non-reentrant reaction settles.

Excluded behavior includes independent multi-result/empty-completion request protocols, synchronous request emissions, reentrant/throwing observers, fractional or zero-delay timing, arbitrary mixed timer/input ordering, sharing, multiple subscribers, physical transport abort, unbounded time, fairness and liveness. Pending work beyond the finite horizon is permitted. Selected trace correspondence and checker agreement do not prove universal refinement of the RxJS implementation.

[coverage.json](coverage.json) preserves all 43 covered source hashes. The model report confirms that its inputs matched the reviewed commit; the comparison report records model/configuration hashes and the code/dependency inputs used for replay. Those hashes were checked against the same source inventory before archiving. Later runs write to ignored `artifacts/` instead of changing this snapshot.

The maintenance drill's local scratch commits are experiment identifiers, not public GitHub revisions. [Independent review notes](independent-review.md) describe an additional semantic inspection and 32 runtime probes; those probes are separate from the 40 named automated tests.
