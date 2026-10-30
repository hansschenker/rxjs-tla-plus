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

## What can move into `rxjs-formal-way` later

The reusable candidates are the explicit event/ownership vocabulary, model-to-code mapping tables, exact-status checking, replay interface, negative controls, and a maintenance workflow with a reviewed source pin. A generated TLA+ exporter or a mandatory verification dependency needs further experiments. Neither is introduced into the canonical repository by this work.

Archived evidence is under [verification/evidence](../verification/evidence/). Read the recorded input hashes and reviewed source SHA when using it; fresh runs write to ignored `artifacts/` instead.
