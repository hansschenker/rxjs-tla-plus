# TLC counterexample replayed against RxJS 7.8.2

The table omits Tick-only states. Equal-time external events retain their sequence order.

| Virtual time | Input / scheduler event | State after reaction | Output / resource action |
|---:|---|---|---|
| 0 | Init | raw=0, pending=0, active=0 | No result |
| 0 | Query 1 | raw=1, pending=1, active=0 | No result |
| 3 | Timer 1 | raw=1, pending=0, active=1 | Subscribe request 1 |
| 4 | Query 2 | raw=2, pending=2, active=1 | No result |
| 4 | Result 1 | raw=2, pending=2, active=0 | Deliver result 1; complete inner |

The baseline delivers request 1 after raw query 2. The immediate-cancellation candidate suppresses that delivery for the same external trace.
