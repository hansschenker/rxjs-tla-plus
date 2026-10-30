# Creation and maintenance workflow trial

This is a repository-local trial of the `create-formal-verification-skill` and `maintain-formal-verification-skill` workflows inspected in [open-pstack](https://github.com/ericlitman/open-pstack/tree/b4c5e3d63318308b7e11f26b2bc156e7793d834a/plugins/pstack/skills). The exact upstream revision and skill blob IDs are recorded in [upstream-lock.json](../upstream-lock.json). We wrote a tailored skill for this laboratory; we did not install global/personal skills or copy the upstream skill bodies.

## Creation trial

The useful target is a concrete pipeline requirement: every search result emitted downstream belongs to the latest accepted raw-query notification. This is stronger than selecting the latest **debounced** query. The distinction leads directly to an observable counterexample and to a candidate with a different cancellation boundary.

The trial produced two specifications, finite configurations, a pinned official TLC runner, independent RxJS tests, and an adapter that replays the actual counterexample. The simpler `take` specification connects the laboratory to the existing canonical Mealy description and includes quota-zero behavior and a deliberately broken quota case.

The project skill records the relevant files, commands, properties, observation boundary, scope limitations and reviewed source identity. An independent review checked the model/runtime correspondence and reproduced all seven TLC outcomes. That review also found two replay-adapter edge cases outside the search model: a query attempted after source completion incorrectly changed the freshness oracle, and explicit null payloads were replaced by a default ID. Both were corrected with regression tests before the source snapshot was recorded.

## Maintenance trial

The runnable drill is `npm run verify:mutation`; its implementation is [check-mutation.mjs](../scripts/check-mutation.mjs). It creates a disposable Git repository under ignored `artifacts/`, with local baseline, implementation-change and model-alignment commits.

| Stage | Question | Required observation |
|---|---|---|
| Reviewed baseline | Are the covered source files unchanged? | Coverage manifest matches |
| Implementation regression | Does immediate selection still cancel on raw input? | It now delegates to delayed selection |
| Existing verification | Can the old model reveal an unmodeled code edit? | The unchanged immediate-policy model still passes |
| Independent evidence | Does the implementation retain the contract? | The real RxJS immediate-cancellation test fails |
| Model maintenance | What happens when the model describes the changed code? | `FreshEmission` fails after changing only the modeled policy |
| Classification | Is this a changed requirement or a bug? | Bug under the unchanged immediate-cancellation contract |

This demonstrates why model checking alone does not prevent implementation/model drift. The source-change guard makes the need for review visible, independent runtime tests expose the observed regression, and the aligned model explains the violating event ordering. The guard's hash equality is not semantic proof.

The drill never repairs or changes the production implementation. It does not weaken `FreshEmission`, turn an unexpected failure into an accepted case, or refresh the reviewed pin. Its scratch repository is removed. Recorded [maintenance evidence](../verification/evidence/maintenance-drill.json) retains the local commit identities, patch, file hashes and classification; those scratch commits are not GitHub commits.

### Forward test with a separate agent

A separate agent received a disposable changed checkout and the generated project skill, with no instruction to repair the implementation. Following the skill, it found the changed cancellation boundary, observed the stale model's successful 619-state check, ran all ten search tests by name (six passed, four failed), and aligned only the model policy. The aligned model violated `FreshEmission` and its actual trace reproduced the bug through the changed runtime entry point. The agent classified the result as an **implementation bug** and left the positive gate failing.

Its [forward-test report](../verification/evidence/skill-forward-test.md) records the commands, local-only source revisions, hashes, trace and interpretation. It also identified two instruction gaps: the automated mutation drill needs a clean reviewed baseline, and a failing aggregate replay may require a focused diagnostic to preserve decoded evidence. The final project skill now explains both cases. These instruction changes were reviewed after the forward test; the test was not rerun against the revised wording.

## Second checker trial prompted by `tla-ts`

The additional [checker comparison](../experiments/03-tla-ts/README.md) feeds the same specifications into `tla-ts@0.0.3` and official TLC. It compares seven outcomes, invariant names, generated/distinct counts and search depths. It also converts `tla-ts`'s structured violation states into the existing RxJS replay interface without parsing console output.

This provides concrete support for using a JavaScript API to surface counterexamples and integrate with future trace tooling. It provides no automatic translation from canonical TypeScript models, no proof of arbitrary RxJS code, and no universal equivalence result for the checkers. Published npm bytes and the inspected upstream Git commit are pinned separately because npm did not supply a `gitHead` field.

## Maintenance continuation: lifecycle and timer boundaries

Experiment 04 extends the laboratory with a separate lifecycle model. The original models and pipeline implementations are preserved. This is an explicit scope extension: source completion/errors, active inner errors, cancellation and two concrete same-frame ordering profiles now have their own model, runtime adapter and correspondence checks.

The existing 22-test baseline was run successfully before editing. The source guard then correctly required review of the added/changed covered files. The new model distinguishes source and destination lifetime; positive checks cover both policies and both ordering profiles. Six deliberately false properties witness lifecycle behavior, and a seventh negative case retains the baseline's unchanged freshness requirement. All seven actual traces are replayed against RxJS by both the official-TLC adapter and the structured `tla-ts` adapter.

The expanded suite contains 40 named tests. One new correspondence test deliberately replays a completion-flush trace with the waiting implementation and requires the gate to reject the mismatch. The original controlled cancellation mutation remains part of the final workflow. An independent reviewer inspected the model, adapter and scheduler argument and ran 32 separate RxJS scenarios; its feedback strengthened the comparison with actual source-owned and destination-closed flags.

The maintenance classification is **verification updated**: the new scope is modeled and reviewed, with no change to the two pipeline functions. The final source pin and [extension evidence](../verification/evidence/lifecycle-extension/README.md) record the executed results and boundaries. A finite-horizon check and selected trace replays still do not establish universal model/implementation refinement.

## Maintenance continuation: independent request notifications

Experiment 05 separates the request's next, complete and error actions. The
previous 18-configuration, 40-test baseline passed before changes. The coverage
guard then reported the new model, adapter, tests and runner changes as requiring
review; its source pin was retained during semantic review and preflight checks.

The new model bounds each request to at most two accepted values for exploration,
without forcing completion at that bound. It preserves both cancellation policies,
both explicit timer-order profiles, source/output separation and ownership.
Notification positions distinguish equal payloads. The correspondence helper
counts accepted input positions independently of model output positions and
rejects invented completion or repeated output positions.

The expanded manifest has 31 configurations. Thirteen belong to the new
experiment: four positive safety checks, one freshness counterexample, seven
reachability witnesses and one deliberate model mutation. Both checkers feed the
eight correct-model negative traces into actual RxJS. The runtime suite adds 20
protocol tests and five correspondence tests, bringing the total to 65.

The new protocol mutation drill inserts take(1) into a disposable copy of the
immediate-policy request pipeline. The unchanged multiple-value/completion test
must reject that implementation. A separate model mutation violates
NextKeepsRequestActive. The two faults differ in underlying teardown reason and
are documented as complementary checks, not equivalent traces.

An independent reviewer found no semantic defect and ran 48 additional direct
RxJS probes, calling retained subscribers even after teardown. This avoids
relying solely on the replay adapter's explicit suppression of closed-request
attempts. The probe script and log are retained with the [request-protocol
evidence](../verification/evidence/request-protocol/README.md), separately from
the 65 automated tests and the finite model's smaller time horizon.

The classification is **verification updated**. Source identity, executed
commands, exact checker outcomes, actual trace correspondence and both mutation
drills are recorded in that snapshot. No canonical operator model or production
search pipeline is changed by this scope extension.

## What can move into `rxjs-formal-way` later

The reusable candidates are the explicit event/ownership vocabulary, model-to-code mapping tables, exact-status checking, replay interface, negative controls, and a maintenance workflow with a reviewed source pin. A generated TLA+ exporter or a mandatory verification dependency needs further experiments. Neither is introduced into the canonical repository by this work.

Archived evidence is under [verification/evidence](../verification/evidence/). Read the recorded input hashes and reviewed source SHA when using it; fresh runs write to ignored `artifacts/` instead.
