# RxJS TLA+ laboratory

An experimental companion to [rxjs-formal-way](https://github.com/hansschenker/rxjs-formal-way), following **Intuition → Specification → Verification**. We use small TLA+ models to investigate observable notifications, subscription ownership, cancellation and bounded time, then check relevant behavior against **real RxJS 7.8.2**.

The first experiments already produce a useful result: `debounceTime(delay), switchMap(search)` can emit an old request's result after a new raw query. Moving request selection to the raw-query boundary prevents that delivery in the checked model and runtime scenarios. The alternatives have different source-completion behavior; choosing one requires an explicit contract.

## Start here

Requirements: Node.js 22 or later, Java 11 or later, Git, and network access for the initial package and tool downloads. The recorded local run used Node 24 and Java 17; CI uses Node 22 and Java 17.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run setup:tlc
npm run verify
npm run verify:mutation
```

TLC is pinned by release and SHA-256 in [toolchain.json](toolchain.json). `setup:tlc` verifies the downloaded JAR. To use an existing copy, set `TLA2TOOLS_JAR` to the same pinned JAR; the checksum is still verified. Model checks use fresh state directories, bounded heap, one worker and fixed exploration settings.

The optional TypeScript implementation of the checker is isolated from the main dependencies:

```sh
npm ci --prefix experiments/03-tla-ts --ignore-scripts --no-audit --no-fund
npm run verify:tla-ts
```

This checks the **same seven TLA+ configurations** with official TLC and `tla-ts`, compares verdicts, violated invariant names, state counts and search depths, and replays the structured search counterexample against RxJS. It requires both checkers because its purpose is comparison.

## Experiments

| Experiment | Question | Evidence |
|---|---|---|
| [01 — `take`](experiments/01-take/README.md) | How does a local Mealy-style contract map to TLA+? | Quota 0 and quota 2 safety checks; a deliberate extra-value mutant fails; 312 bounded real-RxJS histories |
| [02 — search freshness](experiments/02-search-freshness/README.md) | When does a newer raw query invalidate older work? | TLC finds a stale result; its actual trace reproduces in RxJS; immediate cancellation passes the bounded safety model |
| [03 — `tla-ts`](experiments/03-tla-ts/README.md) | Can a TypeScript checker help our workflow? | Differential checking of the unchanged models and direct replay of a structured counterexample |

The two safety checks for `take` complete with 17 and 2 distinct states. The full search structural check completes with 750 distinct states; the immediate-cancellation safety check completes with 619. Deliberately false properties are also required to fail. See [recorded model results](verification/evidence/model-results.json) for the exact bounds, hashes and outcomes.

## A concrete result: the cancellation boundary matters

These functions exist in [runtime/search-pipelines.mjs](runtime/search-pipelines.mjs):

```js
// A raw query waits before replacing the active request.
queries$.pipe(debounceTime(delay, scheduler), switchMap(search));

// A raw query immediately replaces the previous timer/request flow.
queries$.pipe(
  switchMap(query => timer(delay, scheduler).pipe(
    switchMap(() => search(query))
  ))
);
```

The property being investigated is precise: **at every result emission, the result's query notification ID equals the latest accepted raw-query notification ID**. IDs identify individual notifications, even if two queries would carry identical search text. This is a user-interface freshness requirement, not a claim that RxJS implements either operator incorrectly.

With delay 3, TLC finds this trace:

| Time | Input / timer event | Baseline response | Immediate-cancellation response |
|---:|---|---|---|
| 0 | Query 1 | Start waiting | Start waiting |
| 3 | Timer expires | Subscribe request 1 | Subscribe request 1 |
| 4 | Query 2 | Retain request 1 while waiting | Unsubscribe request 1 immediately |
| 4, next event | Result 1 | Emit stale result 1 | Suppress result 1 |

The same-time external events are ordered: query 2 arrives before result 1. This is an actual decoded TLC counterexample, not a hand-written example standing in for one. The replay checks request IDs, start times, output times and the freshness violation. [`tla-ts` reaches the same finding](experiments/03-tla-ts/README.md) through its structured trace API.

On source completion, `debounceTime` flushes a pending query; the timer-based candidate allows its final selected timer/request to finish. Runtime tests preserve that distinction. Unsubscription closes an RxJS subscription; whether it physically aborts network work depends on the request Observable and its teardown.

## How the three descriptions fit together

| Layer | Responsibility | Current boundary |
|---|---|---|
| Mealy-style operator description | Local state, input, output and transition rules | `take` is manually mapped from the pinned canonical model in `rxjs-formal-way` |
| TLA+ model plus checker | Explore all reachable states of the configured abstraction and check named properties | Finite domains; search uses integer time 0…9, delay 3, at most two query notifications |
| Independent RxJS execution | Confirm selected model traces and characterize runtime semantics | RxJS 7.8.2; explicit scheduler and source/request fixtures |

There is no automatic TypeScript-to-TLA+ translation and no proof that every JavaScript execution refines these specifications. `tla-ts` implements the TLA+ checker in TypeScript; its input is still TLA+ and TLC configuration text. Checker agreement on these cases is useful evidence, not a proof of equivalence between the tools.

The search model omits source completion/error, request errors, synchronous request emissions, multiple subscribers, reentrancy, timer-deadline ties and unbounded execution. Some omitted cases have runtime tests, which do not extend the model-checked domain. Each experiment README lists its assumptions and the exact correspondence to code.

## Verification skill trial

The creation and maintenance workflows in [open-pstack](https://github.com/ericlitman/open-pstack) inspired the repository-local [rxjs-pipeline-verification skill](.agents/skills/rxjs-pipeline-verification/SKILL.md). Exact upstream revisions are recorded in [upstream-lock.json](upstream-lock.json).

`npm run check:coverage` compares covered source files with a reviewed content-hash manifest. Added, removed or changed implementation, model, test, toolchain or runner files require review. This detects drift; it does not establish semantic correspondence. Verification never refreshes that manifest automatically.

`npm run verify:mutation` performs a controlled maintenance drill in a disposable copy. It introduces delayed cancellation into the immediate-policy implementation, shows that the unchanged model still passes, confirms that independent runtime tests reject the regression, and aligns the model with the changed code. The aligned model then violates the unchanged freshness property. The production files are left intact.

See [the skill trial record](docs/SKILL-TRIAL.md) and [recorded maintenance evidence](verification/evidence/maintenance-drill.json). A future maintainer should classify a change as **in sync**, **verification updated**, **implementation bug**, or **blocked**; changing a requirement merely to obtain a green check is not maintenance.

## Evidence and reproduction

Fresh runs write reports, logs and counterexamples under ignored `artifacts/`. A failed model run removes the previous summary before checking, so an earlier success cannot masquerade as a new result. The checked-in [verification/evidence](verification/evidence/) directory is a snapshot tied to input hashes and a reviewed source commit. It is not overwritten by normal runs.

The CI workflow runs the source-change guard, official TLC checks, runtime tests, the maintenance mutation and the optional checker comparison. Expected counterexamples must name the intended invariant and return the appropriate status. Parser failures, checker crashes, timeouts and unrelated violations fail the run.

## Next experiments

1. Extend the search model with source completion and errors, then make same-frame timer ordering an explicit scheduler policy.
2. Compare `switchMap`, `concatMap`, `mergeMap` and `exhaustMap` using the same ownership and notification vocabulary.
3. Investigate sharing/ref-count lifetime and a two-source composition such as `combineLatest` or `withLatestFrom`.
4. Evaluate a small exporter from a well-defined subset of the canonical Mealy model to TLA+. Keep independent runtime checks and review the abstraction before generating more operators.

Promote a result into `rxjs-formal-way` only after its contract, scope, correspondence, counterexample replay and maintenance cost are understood. That repository remains the canonical operator-description project; this one is a laboratory.

## Contributors

**ChatGPT (GPT-6 Astra Pro)** is the main contributor to the initial models, implementation, verification harness, experiments and documentation. **Hans Schenker** provides the research direction, RxJS modeling goals and review. Commits include ChatGPT co-author credit.
