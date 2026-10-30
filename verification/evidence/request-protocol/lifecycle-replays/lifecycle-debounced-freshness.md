# lifecycle-debounced-freshness: actual checker trace replayed against RxJS

Policy: debounced; timer order: external-first; delay: 2.

Rows show settled reactions, omitting phase/clock-only transitions. A witness violation may demonstrate reachable behavior rather than a failing application requirement.

| Frame | Event | Source / output state | Request and notification observations |
|---:|---|---|---|
| 0 | Query 1 | open / open | no output or request change |
| 2 | Timer 1 | open / open | start 1 |
| 3 | Query 2 | open / open | no output or request change |
| 3 | Result 1 | open / open | stop 1 (complete); next 1 |
