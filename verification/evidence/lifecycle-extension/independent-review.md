# Independent lifecycle review record

A separate agent reviewed the model, the runtime adapter, the correspondence adapter and RxJS 7.8.2 source for `debounceTime`, `switchMap`, `timer`, `VirtualTimeScheduler`, `OperatorSubscriber` and `Subscriber`. It reported no current semantic mismatch within the declared scope. It made no repository edits.

The reviewer also ran eight independently constructed scenarios across both pipeline policies and both ordering profiles: 32 actual RxJS probes at delay 2. These were inline diagnostic executions, not additional named tests in the committed automated suite.

| Scenario | Independently observed behavior |
|---|---|
| Query at 0, complete at 1, result at 3 | Debounced request starts at 1; immediate request starts at 2; both emit and complete at 3 |
| Error while input waits | Pending input discarded, downstream error, no request started |
| Error with active request | Downstream error and request teardown with reason `unsubscribe` |
| Old inner error while a new query waits | Baseline errors; immediate policy already canceled the old request and ignores the attempt |
| New query exactly at the timer deadline | External-first prevents the old request; timer-first starts it, then immediate selection cancels it |
| Source error exactly at the deadline | No request under external-first; transient start and teardown under timer-first |
| Downstream cancellation at the deadline | Same resource difference, without a downstream terminal notification |
| Query at 0, query at 1, error at 3 | The same ordering argument holds after debounce rearming |

The reviewer confirmed that the half-frame enqueue wrappers implement the declared profiles when external times and delays are integers and delay is positive. The model may abstract earlier debounce wakeups because they only rearm a later deadline and do not select requests or emit notifications in this observation vocabulary.

It emphasized settled reactions: an RxJS error or completion observer runs before all teardown callbacks finish. Observing resources inside those callbacks would need a more detailed model.

Feedback strengthened the correspondence gate to compare actual `sourceOwned` and `destinationClosed` subscription flags with the model, in addition to lifecycle labels. Terminal notifications also use an incrementing counter in the model so a future repeated-emission regression cannot be hidden by assigning a Boolean-like value.

The final `NoResultCompletion` reachability witness was added after this review to demonstrate immediate-policy output followed by destination completion. Its actual trace was subsequently checked by both model checkers and replayed against RxJS in the final automated run. The final source and hashes are in this directory's evidence records.
