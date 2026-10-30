---
name: rxjs-pipeline-verification
description: Create or maintain the bounded TLA+ checks, RxJS runtime correspondence, and reviewed-source coverage for this RxJS laboratory. Use when changing pipeline behavior, models, replay adapters, verification tools, or their tests.
---

# RxJS pipeline verification

## Synchronization

Reviewed source: `b08677e85e04693e588f13a6a8279c43ad803650`.

The exact reviewed source commit and SHA-256 file inventory live in `verification/coverage.json`. Read them before making a verification claim. A documentation/evidence commit may follow the reviewed source commit without changing covered inputs. The guard is change detection, not a proof that a model faithfully represents code.

Upstream workflow inspiration: `create-formal-verification-skill` and `maintain-formal-verification-skill` from `ericlitman/open-pstack` at `b4c5e3d63318308b7e11f26b2bc156e7793d834a`; see `upstream-lock.json` for exact paths and blob IDs. This skill is specific to this repository and is not an installation of those upstream skills.

## 1. Recover the contract and changes

Read `README.md`, `experiments.json`, `verification/coverage.json`, the relevant experiment README, and the source files they map. Inspect `git diff REVIEWED_COMMIT --` for the covered paths, including renames, deletions and untracked additions. Run `npm run check:coverage`; record what changed before considering an update to the pin.

Current correspondences:

| Contract | Specification | Runtime evidence |
|---|---|---|
| `take` quota, notification order and source ownership | `experiments/01-take/Take.tla` plus three configs | `tests/take.test.mjs`, installed RxJS 7.8.2 |
| Latest raw-query notification owns each emitted result | `experiments/02-search-freshness/SearchFreshness.tla` and search configs | `runtime/search-pipelines.mjs`, `runtime/replay-search-trace.mjs`, `tests/search-freshness.test.mjs` |
| Separate source/output lifetime, terminal reactions, and explicit timer-boundary order | `experiments/04-search-lifecycle/SearchLifecycle.tla` and eleven configs | `runtime/replay-lifecycle-trace.mjs`, `tests/search-lifecycle.test.mjs`, `scripts/lifecycle-evidence.mjs` |
| Checker/API agreement for these specifications | Same files read through `experiments.json` | `experiments/03-tla-ts/compare.mjs` |

The freshness requirement is `FreshEmission == ~badEmission`; a result must belong to the latest accepted raw-query notification at its emission. Keep the requirement separate from the implementation policy. `NeverDelivers` is deliberately false: its failure witnesses a reachable delivery, not liveness.

Experiment 04 adds six reachability witnesses for completion flush/wait, pending-input discard on source error, inner error, a request start before same-frame raw input, and a result that completes the destination. Their failure demonstrates reachable behavior; it is not automatically an application bug. The manifest distinguishes `reachability-witness` from the baseline freshness `counterexample`.

## 2. Run existing evidence before repairing it

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run setup:tlc
npm run verify
```

If the coverage guard reports a change, still run the affected evidence directly to understand its status:

```sh
npm run verify:models
node --test tests/search-freshness.test.mjs
node --test tests/take.test.mjs
node --test tests/search-lifecycle.test.mjs tests/lifecycle-evidence.test.mjs
```

Individual TLC cases can be selected with, for example:

```sh
node scripts/check-models.mjs search-immediate
```

Do not interpret a shell/container failure as a property violation. Java needs local sockets for TLC's management service. Actual Node test output should list the named tests, not merely successful loading of test files. If execution is blocked, state the blocker rather than inventing a successful check.

## 3. Map each semantic change explicitly

For a changed pipeline, identify raw notifications, selected inner subscriptions, timer ownership, downstream outputs and terminal events. Define what each atomic action represents and the observation boundary. Read the pinned RxJS source or the installed exact package when operator semantics are uncertain.

For a new bounded model, list the finite value domains, cardinalities, time horizon and scheduler assumptions. Keep time, completion, cancellation and sharing explicit when relevant. A Mealy description may supply local transitions, but composition and environment actions require separate treatment. Do not claim an automatic exporter exists here.

For maintenance, distinguish:

- A stale model that no longer describes the changed implementation.
- An implementation defect under an unchanged contract.
- An intentional contract change supported by the user's task and recorded explicitly.
- Missing evidence or an execution/tool blocker.

Align the verification with the observed implementation without silently weakening the property. If that aligned model violates the requirement, report an implementation bug. Repair production code only when the task authorizes a fix; maintenance itself can finish with a reproducible bug finding.

## 4. Check verdicts and correspondence

`scripts/check-models.mjs` requires official TLC's completed-success marker and exit 0 for positive cases. Negative cases must return exit 12 and the exact invariant named in `experiments.json`. A syntax error, unrelated violation, timeout or crash does not count as an expected failure.

For the search counterexample, replay the checker's actual external Query/Result/Cancel events with the same integer times and event order. Verify result IDs, output times, request start times and the same property violation. Preserve the distinction between subscription cancellation and physical transport abort.

For lifecycle cases, `scripts/lifecycle-evidence.mjs` consumes either official TLC's scalar trace or `tla-ts`'s structured states. Match accepted inputs, request starts/stops and reasons, notifications, freshness, final source/output states, actual source ownership, destination closure and active request IDs. The selected witness endpoints settle through the final integer frame. If a future counterexample stops before a still-due timer in that frame, model or replay the partial phase explicitly; do not erase the extra runtime reaction to obtain agreement.

If an implementation regression stops the aggregate replay before it writes its JSON, retain the raw TLC log in `artifacts/`. Use exported `decodeSearchTrace` from `scripts/check-models.mjs` and `replaySearchTrace` from `runtime/replay-search-trace.mjs` in a focused diagnostic. Check TLC exit 12 and the exact invariant, then compare the failing implementation's output and request start events with the decoded states. Leave the normal positive expectation in `experiments.json` unchanged: a diagnostic that successfully reproduces a bug is not a passing property check.

The optional second-checker comparison is:

```sh
npm ci --prefix experiments/03-tla-ts --ignore-scripts --no-audit --no-fund
npm run verify:tla-ts
```

`tla-ts` consumes TLA+ text. Its structured trace is useful for adapters; agreement on these 18 cases does not establish universal equivalence with TLC. The comparison replays the initial freshness trace and seven lifecycle traces. No temporal/liveness properties are exercised in the current experiments.

## 5. Demonstrate fault sensitivity

```sh
npm run verify:mutation
```

This controlled drill uses a disposable local Git repository. It changes immediate cancellation to delayed selection, observes source drift, runs the unchanged model, runs independent RxJS checks, and aligns only the model policy with the changed code. It preserves `FreshEmission` and expects the aligned model to violate it. Logs and commit identities remain in `artifacts/maintenance-drill.*`; the temporary implementation is discarded.

The drill requires a clean reviewed baseline. During an already-drifted maintenance task, record that prerequisite failure and use the actual regression plus focused model/runtime checks as fault-sensitivity evidence. Do not refresh the coverage pin to make the drill start. Re-run the automated drill after an authorized repair and reviewed source update.

For a new property, choose a similarly targeted defect and show that the relevant model or independent runtime evidence rejects it. Do not modify the expected requirement to make the defect pass. Do not treat a mutation that only changes a model as proof of implementation sensitivity.

## 6. Record a reviewed result

Report the exact commands, verdicts, checked bounds, input hashes and runtime correspondence. Include any counterexample and its interpretation. Explain what remains unmodeled. Use one status: **in sync**, **verification updated**, **implementation bug**, or **blocked**.

Only after semantic review and relevant checks, commit the covered source. Record the source commit deliberately:

```sh
node scripts/check-coverage.mjs --record REVIEWED_SOURCE_COMMIT
npm run verify
npm run verify:mutation
```

The recorder checks that every covered working file exactly matches that commit. It will not record a dirty implementation. Update this synchronization note with the reviewed SHA and save selected evidence under `verification/evidence/`; normal runs continue to use ignored `artifacts/`. Commit the pin, skill note and evidence separately. Do not refresh the pin merely to silence the guard, and do not claim a bug is fixed because verification now describes it.

## Scope reminders

`take` uses quiescent, non-reentrant notification steps. The search model covers at most two distinct query notification IDs, delay 3, integer time through 9, one subscriber and one result followed by completion per request. It excludes timer-deadline ties, synchronous request emissions, source completion/errors, request errors, reentrancy, sharing and fairness/liveness claims. Runtime tests for some excluded cases provide additional runtime evidence, not broader model checking.

That narrower search model is experiment 02. Experiment 04 separately covers source completion, source and active-inner errors, cancellation, and external-first/timer-first frame profiles. It uses delay 2, horizon 4 and at most two query notifications. Positive integer delays and integer external frames justify the timer-first enqueue mechanism, including debounce rearming. State observations are after a reaction settles, not inside observer callbacks. It still excludes multi-value/empty-completing requests, synchronous subscription emissions, fractional/zero delays, arbitrary mixed timer/input order, reentrancy, sharing, fairness and liveness. Pending work beyond the finite horizon is allowed.

Changes in this laboratory do not authorize changes to `hansschenker/rxjs-formal-way`.
