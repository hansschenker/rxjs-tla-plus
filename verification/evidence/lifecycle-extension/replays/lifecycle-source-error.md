# lifecycle-source-error: actual checker trace replayed against RxJS

Policy: immediate; timer order: external-first; delay: 2.

Rows show settled reactions, omitting phase/clock-only transitions. A witness violation may demonstrate reachable behavior rather than a failing application requirement.

| Frame | Event | Source / output state | Request and notification observations |
|---:|---|---|---|
| 0 | Query 1 | open / open | no output or request change |
| 0 | SourceError | errored / errored | E |
