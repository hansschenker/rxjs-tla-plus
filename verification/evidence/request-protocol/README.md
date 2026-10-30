# Request notification protocol: reviewed execution evidence

Reviewed source: [4b80ea40adad33464bcc3787b797bb9c2a0444ac](https://github.com/hansschenker/rxjs-tla-plus/commit/4b80ea40adad33464bcc3787b797bb9c2a0444ac).
The publication commit adds this evidence and synchronization notes without
changing the 62 covered source files. Earlier
[initial](../README.md) and [lifecycle](../lifecycle-extension/README.md) snapshots
remain historical records.

## Executed gates

| Command | Actual outcome | Record |
|---|---|---|
| npm run verify | Source identity guard passed; all 31 expected official-TLC outcomes; all 65 named tests passed | [verification.log](verification.log), [model-results.json](model-results.json) |
| npm run verify:tla-ts | Both checkers agreed on all 31 verdicts, named violations, generated/distinct counts and depths; all selected traces matched RxJS | [tla-ts-results.json](tla-ts-results.json), [command log](tla-ts-command.log) |
| npm run verify:mutation | Drift detected; unchanged model passed; actual cancellation regression rejected; aligned model violated unchanged freshness | [maintenance-drill.json](maintenance-drill.json), [command log](maintenance-command.log) |
| npm run verify:protocol-mutation | Unchanged protocol test passed for the baseline and rejected a disposable take(1) implementation regression | [protocol-mutation.json](protocol-mutation.json), [command log](protocol-mutation-command.log) |

The manifest contains 12 complete positive explorations and 19 expected negative
cases across four models. A negative must fail its exact named invariant with
the required status. A parser error, exception, timeout or unrelated violation
fails the gate.

The automated suite comprises the previous 40 tests, 20 request-protocol tests,
and five protocol-correspondence tests. The original 312 bounded take histories
remain within that suite. The independent 48 probes described below are
additional runtime evidence, not part of the 65-test count.

The [baseline log](baseline.log) records the previous 18 configurations and
40 tests passing before edits. The [pre-review drift log](pre-review-drift.log)
records the intended additions/changes while the old source pin was still in
place. The new pin was recorded only after semantic review, successful model and
runtime checks, and committing the reviewed source.

Recorded local tools: Node 24.22.1, Java 17.0.20, RxJS 7.8.2, official TLA+
tools v1.7.4 reporting TLC 2.19, and published npm tla-ts 0.0.3. CI uses Node 22
and Java 17. Lockfiles and the official JAR checksum remain pinned.

## Complete protocol safety explorations

| Pipeline policy | Frame order | Generated | Distinct | Depth |
|---|---|---:|---:|---:|
| Debounced selection | External first | 3,123 | 2,112 | 25 |
| Debounced selection | Timer first | 5,000 | 3,174 | 26 |
| Immediate selection | External first | 1,554 | 1,070 | 23 |
| Immediate selection | Timer first | 2,731 | 1,777 | 26 |

All four explorations completed with empty queues. Both policies satisfy the
configured request-notification, terminal and ownership invariants. Immediate
selection also satisfies freshness under both profiles. The separate debounced
freshness configuration fails that unchanged requirement as intended.

## Actual protocol trace replays

The official-TLC path decodes scalar observations from the checker output.
The tla-ts path consumes structured states. Both independently feed the same
external event vocabulary through the real RxJS pipeline functions.

| Trace | Reachable behavior | Recorded table |
|---|---|---|
| Debounced freshness | An old request can emit after newer raw input | [freshness](replays/protocol-debounced-freshness.md) |
| Multiple values | Two next notifications leave the request open | [multiple values](replays/protocol-multiple-values.md) |
| Empty completion | A request can complete the destination without producing a value | [empty completion](replays/protocol-empty-completion.md) |
| Next after source completion | A completed source can retain a request that emits while output stays open | [next after source completion](replays/protocol-next-after-source-complete.md) |
| Multiple values then completion | Two values and a separate inner completion finish the destination | [multiple values then completion](replays/protocol-multi-value-completion.md) |
| Next then error | An error terminates output after an earlier delivered value | [next then error](replays/protocol-next-then-error.md) |
| Replacement after a value | New raw input cancels a request that already delivered a value | [replacement](replays/protocol-switch-after-value.md) |
| Cancellation after a value | Downstream cancellation closes a partly delivered request without a terminal notification | [cancellation](replays/protocol-cancel-after-value.md) |

Each table has neighboring JSON containing the actual decoded states, replayed
events, expected observations and runtime result. The helper compares output
request IDs and positions, accepted inner N/C/E events, counts, start/stop times
and reasons, freshness, and actual final ownership. Accepted input positions are
counted independently of the model's output-position observations.

The same run also retains the original
[search counterexample](search-counterexample.md) and seven
[lifecycle trace replays](lifecycle-replays/). Eight new protocol traces are
replayed by each checker path. The ninth new negative configuration is a
deliberate faulty model and is excluded from correct-runtime correspondence.

## Fault sensitivity

The model-only CompleteOnNext mutation violates NextKeepsRequestActive on the
first delivered value. Its [raw TLC log](protocol-mutant-complete-on-next.log)
records the exact invariant failure.

The separate implementation mutation adds take(1) to the selected request in a
disposable copy. The unchanged named source-completion/multiple-value test first
passes against the baseline, then fails against that implementation.

| Observation | Correct implementation | Mutated implementation |
|---|---|---|
| First value | Frame 2 | Frame 2 |
| Second value | Frame 3 | Suppressed after premature closure |
| Destination completion | Frame 4, on independent inner completion | Frame 2, after first value |
| Underlying request stop | Complete at frame 4 | Unsubscribe at frame 2 |

The production pipelines are unchanged. The mutation's raw named-test output is
in [protocol-mutation.log](protocol-mutation.log). These two faults provide
complementary checks: the model mutation invents request completion, while
take(1) unsubscribes the underlying request. Their teardown traces are not claimed
to match.

## Independent review and direct RxJS probes

An independent reviewer inspected the new model, adapter, correspondence helper,
runner integration, tests and implementation mutation drill and found no
substantive defect. [Review notes](independent-review.md) record that scope.

The retained [probe script](independent-probes.mjs) runs 12 scenarios under both
policies and both timer-order profiles: 48 probes, all passing in the
[recorded log](independent-probes.log). It imports the real pipelines and RxJS
directly, without the production replay adapter or model decoder. It calls
retained request Subscribers after teardown, so actual RxJS suppresses late
notifications rather than relying on the adapter's explicit closed-request filter.

Reproduce these supplementary probes from the repository root:

    node verification/evidence/request-protocol/independent-probes.mjs

The probes use frames through 10. They provide additional runtime evidence
outside the model's frame-4 horizon and are not part of the CI test count.

## Bounds and provenance

Experiment 05 fixes delay 2, integer time 0 through 4, at most two query
notifications and at most two accepted next notifications per request. The
value bound limits model exploration; it does not force a terminal event and
does not add a take(2) policy to the runtime. Completion and error remain
independent actions, and an open request may survive the finite horizon.

There is one subscriber, one pending timer and at most one selected request.
The source is live; requests start independent executions when subscribed.
Both external-first and timer-first frame profiles are explicit. The model
uses opaque request/position identities; the runtime tests additionally check
payload identity, repeated payloads, null and explicit undefined.

Excluded behavior includes synchronous subscription emissions, reentrant or
throwing observers/teardown, arbitrary within-frame mixed timer/input ordering,
zero/fractional delay, sharing/multiple subscribers, physical transport abort,
unbounded time, fairness and liveness. Trace correspondence and checker
agreement do not establish universal implementation refinement.

[coverage.json](coverage.json) preserves all 62 reviewed file hashes. The model
report confirms that its recorded inputs match the reviewed source commit.
All model/configuration hashes and comparison/runtime-tool input hashes were
checked against this same inventory before archiving. Fresh runs write to
ignored artifacts rather than overwriting this snapshot.
