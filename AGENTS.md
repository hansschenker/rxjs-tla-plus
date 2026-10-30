# Working in this laboratory

Use `.agents/skills/rxjs-pipeline-verification/SKILL.md` when changing a covered model, runtime adapter, pipeline, verification script or test. Its exact reviewed source revision is recorded in `verification/coverage.json`.

Keep the Intuition → Specification → Verification progression. Prefer pure functions and explicit event/state values. Keep RxJS 7.8.2, model bounds and scheduler assumptions visible. This repository is experimental; changes here do not authorize changes to `rxjs-formal-way`.

Run `npm run verify` for the ordinary gate. Use `npm run verify:mutation` to demonstrate drift and fault sensitivity. For changes affecting checker comparison, install the isolated dependency with `npm ci --prefix experiments/03-tla-ts --ignore-scripts` and run `npm run verify:tla-ts`.

A successful bounded model check is evidence about the declared model. Independently check relevant behavior against RxJS. Never claim automatic refinement, universal liveness, scheduler equivalence or physical network abort without additional evidence. Preserve requirements while diagnosing failures; record changed assumptions explicitly.

Do not refresh coverage pins automatically. Inspect the semantic diff, run relevant checks, commit the reviewed source, then run `node scripts/check-coverage.mjs --record REVIEWED_COMMIT` and update the project skill's synchronization note. Documentation/evidence-only commits may follow that source commit.

Retain upstream source pins and meaningful ChatGPT co-author credit. Avoid copying external skill text or installing personal/global skills as part of routine project work.
