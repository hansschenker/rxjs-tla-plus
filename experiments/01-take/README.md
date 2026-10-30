# Experiment 01: `take` and subscription lifetime

## Intuition

Values arrive one at a time. With `take(2)`, the first two values flow downstream
unchanged. Delivery of the second value is followed by completion and release of
the source subscription. An earlier source completion, source error, or downstream
cancellation can stop the execution with fewer values.

`take(0)` completes when subscribed, without subscribing to the source. Creating
the Observable description does not connect it. Each subscription owns a fresh
counter; this experiment introduces no sharing.

The question is deliberately small: **can a modeled execution deliver more values
than the requested quota, violate the notification protocol, or retain a source
subscription after closing?**

## Specification and scope

`Take.tla` is a handwritten experimental projection of the canonical `take` profile
in `rxjs-formal-way`. It does not replace that profile and is not an automatic
TypeScript-to-TLA+ translation.

| Item | Scope |
|---|---|
| Canonical source | [`src/models/take.ts`](https://github.com/hansschenker/rxjs-formal-way/blob/6ba40c5ba2c8b49b94139ce698b8605cf664a104/src/models/take.ts) |
| Canonical revision | `6ba40c5ba2c8b49b94139ce698b8605cf664a104` |
| Source blob | `fa7eb716baa16d778d5cddde53634ae5af457900` |
| Runtime dependency | RxJS `7.8.2` |
| Quotas checked | `0` and `2` |
| Payload domain in TLC | Two opaque values: `"a"` and `"b"`, including repetition |
| Error domain in TLC | One abstract source-error event; error identity is checked separately at runtime |
| Ownership | One downstream execution and at most one source subscription |
| Event ordering | Sequential external inputs; each reaction is observed at quiescence |
| Time | No clock, timer, scheduler, or elapsed-time claim |
| Termination | Source complete, source error, quota reached, and downstream cancellation |
| Progress | Safety only; no fairness or eventual-completion claim |

Observers do not reenter, unsubscribe during delivery, or throw. Teardown does
not throw. The runtime driver uses a manually driven source; emissions during
source subscription, unrelated source side effects, and nested delivery are
outside this pilot. Negative, fractional, infinite, and unsafe integer counts
are also outside the canonical profile.

The model accepts inputs only after subscription and before closure. A closed
execution can only stutter. The runtime tests additionally attempt later source
notifications to confirm that RxJS suppresses them after closure.

### Mapping to the canonical Mealy rules

| Canonical rule | TLA+ action and condition | Observed action order |
|---|---|---|
| `TAKE-INIT-ZERO` | `Subscribe`, `Quota = 0` | Complete; do not acquire source |
| `TAKE-INIT-POSITIVE` | `Subscribe`, `Quota > 0` | Acquire source |
| `TAKE-NEXT-PASS` | `SourceNext`, `seen + 1 < Limit` | Forward value |
| `TAKE-NEXT-LAST` | `SourceNext`, `seen + 1 = Limit` | Forward value, complete, release source |
| `TAKE-SOURCE-COMPLETE` | `SourceComplete` | Complete, release source |
| `TAKE-SOURCE-ERROR` | `SourceError` | Error, release source |
| `TAKE-CANCEL` | `Cancel` | Release source without notifying downstream |

In the intended configurations, `Limit = Quota`. The mutation changes `Limit`
while retaining the requested `Quota` and its invariant.

`phase` and `closeReason` project the canonical control state. `seen` is retained
after closure as an observation variable even though the canonical closed state
does not store it. Input/output histories, notification kinds, acquisition and
release counts, and the last event/action word are observation variables used to
state checks and explain counterexamples. They are not additional RxJS features.

### Properties checked

| Invariant | Meaning |
|---|---|
| `TypeOK` | State variables stay within the declared domains |
| `QuotaBound` | The number of delivered values never exceeds the requested quota |
| `ValuePreservation` | Accepted source values are forwarded unchanged and in order |
| `OutputAccounting` | The counter agrees with output history and next notifications |
| `NotificationProtocol` | Complete/error is unique and terminal |
| `SourceLifetime` | The source is connected exactly while the execution is active, and acquisition/release accounting agrees |
| `ZeroNeverSubscribes` | A zero quota never acquires a source subscription |
| `ClosureAgrees` | Complete, error, and silent cancellation agree with the recorded closing reason |
| `QuotaCompletion` | Closing because of the quota occurs after exactly the requested number of values |

The state space is finite because each execution accepts at most two values
(three in the deliberate mutant), and the value domain is finite. No arbitrary
trace-depth cutoff or state constraint prunes the intended TLC models. TLC
explores their reachable state graphs, including closed-state self-loops. The
reported search depth is a result of this model, not a separately imposed bound.

## Verification

Run from the repository root after installing the documented dependencies. Use a
new metadata directory for each TLC run:

```sh
take_two_meta=$(mktemp -d)
java -XX:+UseParallelGC -cp .tools/tla2tools-1.7.4.jar tlc2.TLC \
  -workers 1 -seed 1 -metadir "$take_two_meta" \
  -config experiments/01-take/take-two.cfg experiments/01-take/Take.tla

take_zero_meta=$(mktemp -d)
java -XX:+UseParallelGC -cp .tools/tla2tools-1.7.4.jar tlc2.TLC \
  -workers 1 -seed 1 -metadir "$take_zero_meta" \
  -config experiments/01-take/take-zero.cfg experiments/01-take/Take.tla

take_mutant_meta=$(mktemp -d)
java -XX:+UseParallelGC -cp .tools/tla2tools-1.7.4.jar tlc2.TLC \
  -workers 1 -seed 1 -metadir "$take_mutant_meta" \
  -config experiments/01-take/mutant-extra-value.cfg experiments/01-take/Take.tla

node tests/take.test.mjs
```

The third TLC command **must fail with `Invariant QuotaBound is violated`**.
A parser error, a missing Java installation, a socket failure, or an unrelated
invariant failure is not a successful mutation check. The intended configurations
must complete without invariant violations. The runtime test suite must pass;
its negative test passes only when the quota oracle rejects the mutant.

### Recorded evidence: 2026-10-30

Toolchain: Java 17, the official `v1.7.4` TLA+ tools JAR (which reports TLC
`2.19`, revision `5a47802`), Node `24.22.1`, RxJS `7.8.2`.

| Check | Observed result |
|---|---|
| `take-two.cfg` | Pass; 30 states generated, 17 distinct, queue empty; depth 4; exit 0 |
| `take-zero.cfg` | Pass; 3 states generated, 2 distinct, queue empty; depth 2; exit 0 |
| `mutant-extra-value.cfg` | Expected `QuotaBound` violation; 21 states generated, 18 distinct before stopping; counterexample has 5 states; exit 12 |
| `node tests/take.test.mjs` | 9 tests passed, including 312 bounded runtime histories and an expected mutant rejection |

The mutant counterexample is: initialize; subscribe; receive `a`; receive `a`;
receive `a` again. The mutant delivers three values for a requested quota of two,
then completes. The third delivery falsifies `QuotaBound`. Repeated equal values
still count as distinct notifications.

The runtime negative test runs `take(3)` against the `take(2)` quota oracle.
This is an intentional wrong-configuration surrogate for the extra-value defect,
not a claim that RxJS `take(3)` is faulty. It exercises the same property with a
separate implementation execution. It does not automatically translate TLC traces
or prove equivalence between the TLA+ and TypeScript models.

The 312 runtime histories cover all input sequences of lengths zero through three
over `next(a)`, `next(b)`, complete, error, and cancel, for both quotas. These are
bounded implementation checks. They are separate evidence from the completed
finite-state TLC exploration and do not prove all JavaScript behaviors.

## Maintenance boundary

Review this experiment when any mapped canonical rule, its scope, the RxJS
version, or the source/subscription assumptions change. Check the source mapping
before rerunning; a green run of an unchanged TLA+ model cannot detect TypeScript
drift by itself. Advance the recorded canonical revision only after that review.
The canonical repository remains unchanged by this experiment.
