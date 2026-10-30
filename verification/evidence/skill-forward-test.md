# Verification skill forward test

**Status: implementation bug.** The skill led to a reproducible defect under the unchanged freshness contract. Verification was aligned with the changed implementation; the defect was not repaired, and the verification gate remains red.

## Contract and reviewed change

- Reviewed source: `7ac198a596d4d486930c1acaa087c75f9c338d4e`, as recorded in `verification/coverage.json`.
- Trial source: `094b4b56a77d9e3ead2837f2725c0f7724a8a983`.
- Covered semantic diff: `createImmediateCancelSearch$` now immediately returns `createDebouncedSearch$`, making its original timer/switchMap implementation unreachable.
- Contract: each emitted result belongs to the latest accepted raw-query notification. `FreshEmission == ~badEmission` remains unchanged.

A raw query now resets the silence timer while retaining the previous request. Only the subsequent debounced selection replaces that request. Thus request ownership moves from the raw-query boundary to the debounce boundary. Source completion also flushes pending input, unlike the original selected-timer behavior; this difference is covered by runtime tests and remains outside the bounded search model.

## Commands and actual outcomes

All commands ran from this disposable repository, with:

```sh
export TLA2TOOLS_JAR=/workspace/scratch/13c2db68ab78/rxjs-tla-plus/.tools/tla2tools-1.7.4.jar
```

Dependencies were reused as instructed; no packages were installed. Node subprocesses and TLC ran with the required execution permission. Actual named test output was inspected.

| Command | Outcome |
|---|---|
| `git diff 7ac198a596d4d486930c1acaa087c75f9c338d4e -- runtime scripts tests experiments .github package.json package-lock.json toolchain.json experiments.json upstream-lock.json` | One implementation line changed; no initial covered model/test changes. Working-tree status was initially clean. |
| `npm run check:coverage` | Exit 1; detected `changed: runtime/search-pipelines.mjs`. |
| `npm run verify` | Exit 1 at the coverage guard; later stages were not run by this command. |
| `npm run verify:models` | Exit 1 during the search counterexample's immediate-runtime assertion (`1 !== 0`). Before that, take-two passed (17 distinct states), take-zero passed (2), take-mutant violated `QuotaBound` as required (18), and search-structure passed (750). The debounced TLC log contains the required `FreshEmission` violation. |
| `node --test --test-reporter=tap tests/search-freshness.test.mjs` | Exit 1; 10 named tests executed, 6 passed and 4 failed. Failures cover immediate request cancellation, source-completion timing in two cases, and equal-frame timer/request teardown. The freshness test observed stale result 1 at time 5 after query 2 at time 4. |
| `node --test --test-reporter=tap tests/take.test.mjs` | Exit 0; all 9 named tests passed, including all 312 bounded histories. |
| `node scripts/check-models.mjs search-immediate` before alignment | Exit 0; stale immediate-policy model passed: 1,054 generated / 619 distinct states, queue 0, depth 17. This does not validate the changed implementation. |
| `npm run verify:mutation` | Exit 1 at its initial coverage guard. The mutation drill did not start. |
| `node scripts/check-models.mjs search-immediate` after alignment | Exit 1 because the unchanged positive gate received TLC exit 12. Raw output identifies `FreshEmission`. |
| `node artifacts/forward-test/diagnose-aligned.mjs` | Diagnostic exit 0: confirmed TLC exit 12 and exact `FreshEmission`, then matched the actual trace's outputs and request starts against changed RxJS. 139 generated / 101 distinct states, queue 23. This successful reproduction records a failing property. |

Logs, the diagnostic script, the saved stale-model report, and full aligned evidence are in `artifacts/forward-test/`.

## Verification maintenance and correspondence

Changed only `experiments/02-search-freshness/immediate.cfg` from `Policy = "immediate"` to `Policy = "debounced"`. Kept the model invariant, bounds, runtime assertions, and `experiments.json` positive expectation intact. The model now describes the changed cancellation policy and rejects it under the existing requirement.

The aligned TLC counterexample, independently replayed through the changed **immediate** runtime entry point, is:

| Time | Event | Observed meaning |
|---:|---|---|
| 0 | Query 1 | Deadline 3; no active request. |
| 3 | Timer 1 | Request 1 starts. |
| 4 | Query 2 | Deadline 7; request 1 remains active. |
| 4, next event | Result 1 | Output 1 is emitted although latest raw query is 2; request 1 completes. |

The replay matched output `(time 4, ID 1)`, request start `(time 3, ID 1)`, and the same freshness violation. Integer times and equal-time external ordering were preserved. The diagnostic JSON contains the complete decoded TLC trace and RxJS log.

Bounds remain two distinct query IDs, delay 3, integer time 0–9, one subscriber, one pending wait and one active request, and one result followed by inner completion per request. Timer-deadline ties, synchronous request results, source completion/errors, request errors, reentrancy, sharing and fairness/liveness remain unmodeled. Subscription teardown does not establish physical transport abort.

Runtime was Node `v24.22.1`, RxJS `7.8.2`, and checksum-verified TLC `2.19` from tools release `v1.7.4`. Core SHA-256 inputs:

| Input | SHA-256 |
|---|---|
| Changed runtime | `a5d0e3559f212b8590a86aa44ac853faa6475ab776a47e6f8ad3d8af160210bb` |
| Unchanged search model | `2886a2b9e129266e5ddea3f327aa41f76b7280a1e3654b088f2eccf9202bf7a2` |
| Original immediate configuration | `b39b1c16ceb09c65a6b939d5f318bc74a7d0d2b53a0d70ac8aecc977041a3b1c` |
| Aligned immediate configuration | `94d019b12de8c9f27693cedbc4bb51e30a50652ddeae63985909c0b9ccbe8918` |
| TLC JAR | `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88` |

## Skill gaps and disposition

The skill's distinction between stale models and implementation defects worked. Two small workflow gaps surfaced:

1. `verify:mutation` requires clean coverage, so its documented drill cannot start during an already-drifted maintenance task. The skill could explicitly permit recording that prerequisite failure and using the current regression as the fault-sensitivity evidence.
2. The aggregate model runner aborts before saving decoded replay evidence when the immediate implementation is broken. The skill could give an explicit diagnostic recipe for preserving the actual failing trace and its runtime replay while leaving the normal positive expectation unchanged. The local diagnostic script supplies that evidence here.

No tool/execution blocker remains. The optional second-checker comparison was not run because checker-comparison behavior was unchanged. No implementation fix, requirement weakening, coverage-pin refresh, source commit, or publication was performed. The only tracked working-tree edit is the model-policy alignment inside this disposable copy; the report is a new file. The parent repository was not modified by this trial.
