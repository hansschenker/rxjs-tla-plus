# protocol-debounced-freshness: actual checker trace replayed against RxJS

Policy: debounced; timer order: timer-first; delay: 2; maximum values per request: 2.

Value labels are request ID:position. Payloads are opaque. Rows omit phase/clock transitions; a reachability witness is an existence check, not an eventual-delivery guarantee.

| Frame | Event | Source / output state | Active request | Observations |
|---:|---|---|---|---|
| 0 | Query 1 | open / open | none | no output or request change |
| 2 | Timer 1 | open / open | 1 (0 values) | start 1 |
| 2 | Query 2 | open / open | 1 (0 values) | no output or request change |
| 2 | InnerNext 1 | open / open | 1 (1 values) | next 1:1 |
