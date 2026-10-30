# Recorded verification evidence

The main recorded run checks source commit [`b08677e85e04693e588f13a6a8279c43ad803650`](https://github.com/hansschenker/rxjs-tla-plus/commit/b08677e85e04693e588f13a6a8279c43ad803650). A later commit adds this evidence, the coverage manifest and final skill/documentation notes. Covered implementation, model, test, toolchain and workflow files are unchanged from that source commit.

Environment: Node `24.22.1`, RxJS `7.8.2`, Java `17.0.20`, official TLA+ tools release `v1.7.4` reporting TLC `2.19`, and optional published npm `tla-ts@0.0.3`. Exact package integrity, tool checksum and upstream source revisions are stored in the repository lockfiles. This is a bounded model-checking experiment, not an unbounded proof or a performance benchmark.

| Recorded command | Outcome | Evidence |
|---|---|---|
| `npm run verify` | Reviewed-source guard passed; seven expected TLC outcomes; 22 named tests passed | [verification.log](verification.log), [model-results.json](model-results.json) |
| `npm run verify:mutation` | Changed source detected; stale model passed; real runtime regression failed; aligned model violated unchanged `FreshEmission` | [maintenance-drill.json](maintenance-drill.json), [raw log](maintenance-drill.log) |
| `npm run verify:tla-ts` | All seven verdicts, invariant names, generated/distinct counts and depths agreed; structured trace reproduced in RxJS | [tla-ts-results.json](tla-ts-results.json), [command log](tla-ts-command.log) |
| Separate-agent skill forward test | Classified controlled change as implementation bug; aligned model and actual runtime trace corroborate it | [skill-forward-test.md](skill-forward-test.md), [forward-test/](forward-test/) |

The main model report records SHA-256 hashes of its inputs and confirms they matched the stated source commit. [../coverage.json](../coverage.json) identifies all 27 covered source files. Its ordinary check verifies both the working files and the referenced Git commit, but this identity check does not prove semantic model/code correspondence.

The `tla-ts` report records each model/configuration hash and the structured replay. These inputs match the main model report. It is a comparison against published package bytes pinned by npm integrity, not an assertion that the package equals the inspected upstream Git revision.

The maintenance drill's three scratch Git commits and the forward test's earlier local source revisions are **local-only experiment identifiers**, not GitHub links. The forward-test baseline's covered source contents are the same as the published source snapshot. The archived report retains the original paths and command output; `forward-test/diagnose-aligned.mjs.txt` is a record of the diagnostic script in its original location, not a new root executable. The project skill's two wording improvements were made after this forward test and were not forward-tested again.

Fresh commands write to ignored `artifacts/`, leaving this snapshot intact. To evaluate a later change, read its actual input hashes and verdicts instead of treating the historical snapshot as current evidence. Deliberately false invariants and runtime mutants are required negative controls; their failures are not failures of the overall experiment.
