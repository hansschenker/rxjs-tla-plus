# lifecycle-result-completion: actual checker trace replayed against RxJS

Policy: immediate; timer order: timer-first; delay: 2.

Rows show settled reactions, omitting phase/clock-only transitions. A witness violation may demonstrate reachable behavior rather than a failing application requirement.

| Frame | Event | Source / output state | Request and notification observations |
|---:|---|---|---|
| 0 | Query 1 | open / open | no output or request change |
| 0 | SourceComplete | completed / open | no output or request change |
| 2 | Timer 1 | completed / open | start 1 |
| 2 | Result 1 | completed / completed | stop 1 (complete); next 1; C |
