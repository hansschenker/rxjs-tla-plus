# lifecycle-completion-flush: actual checker trace replayed against RxJS

Policy: debounced; timer order: external-first; delay: 2.

Rows show settled reactions, omitting phase/clock-only transitions. A witness violation may demonstrate reachable behavior rather than a failing application requirement.

| Frame | Event | Source / output state | Request and notification observations |
|---:|---|---|---|
| 0 | Query 1 | open / open | no output or request change |
| 0 | SourceComplete | completed / open | start 1 |
