------------------------------ MODULE Take ------------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Quota, Values, ExtraValue

ASSUME /\ Quota \in Nat
       /\ IsFiniteSet(Values)
       /\ Values # {}
       /\ ExtraValue \in BOOLEAN

\* ExtraValue is a deliberate, named mutation. The requested Quota is unchanged.
Limit == IF ExtraValue /\ Quota > 0 THEN Quota + 1 ELSE Quota

VARIABLES phase, seen, received, output, notifications,
          sourceConnected, acquisitions, releases, closeReason,
          lastEvent, lastActions

vars == <<phase, seen, received, output, notifications,
          sourceConnected, acquisitions, releases, closeReason,
          lastEvent, lastActions>>

Init ==
    /\ phase = "Unsubscribed"
    /\ seen = 0
    /\ received = <<>>
    /\ output = <<>>
    /\ notifications = <<>>
    /\ sourceConnected = FALSE
    /\ acquisitions = 0
    /\ releases = 0
    /\ closeReason = "none"
    /\ lastEvent = "init"
    /\ lastActions = <<>>

\* TAKE-INIT-ZERO and TAKE-INIT-POSITIVE.
Subscribe ==
    /\ phase = "Unsubscribed"
    /\ phase' = IF Quota = 0 THEN "Closed" ELSE "Active"
    /\ notifications' = IF Quota = 0 THEN <<"complete">> ELSE <<>>
    /\ sourceConnected' = (Quota > 0)
    /\ acquisitions' = IF Quota = 0 THEN 0 ELSE 1
    /\ closeReason' = IF Quota = 0 THEN "quota" ELSE "none"
    /\ lastEvent' = "subscribe"
    /\ lastActions' = IF Quota = 0
                      THEN <<"notify.complete">>
                      ELSE <<"source.subscribe">>
    /\ UNCHANGED <<seen, received, output, releases>>

\* TAKE-NEXT-PASS and TAKE-NEXT-LAST. One external event is an atomic step.
SourceNext(value) ==
    /\ phase = "Active"
    /\ seen < Limit
    /\ seen' = seen + 1
    /\ received' = Append(received, value)
    /\ output' = Append(output, value)
    /\ phase' = IF seen' = Limit THEN "Closed" ELSE "Active"
    /\ notifications' = IF seen' = Limit
                          THEN notifications \o <<"next", "complete">>
                          ELSE Append(notifications, "next")
    /\ sourceConnected' = (seen' < Limit)
    /\ releases' = IF seen' = Limit THEN 1 ELSE releases
    /\ closeReason' = IF seen' = Limit THEN "quota" ELSE "none"
    /\ lastEvent' = "source.next"
    /\ lastActions' = IF seen' = Limit
                      THEN <<"notify.next", "notify.complete", "source.unsubscribe">>
                      ELSE <<"notify.next">>
    /\ UNCHANGED acquisitions

Finish(reason, event, terminal, actions) ==
    /\ phase = "Active"
    /\ phase' = "Closed"
    /\ notifications' = IF terminal = "none"
                          THEN notifications
                          ELSE Append(notifications, terminal)
    /\ sourceConnected' = FALSE
    /\ releases' = 1
    /\ closeReason' = reason
    /\ lastEvent' = event
    /\ lastActions' = actions
    /\ UNCHANGED <<seen, received, output, acquisitions>>

\* TAKE-SOURCE-COMPLETE, TAKE-SOURCE-ERROR, and TAKE-CANCEL.
SourceComplete == Finish("complete", "source.complete", "complete",
                         <<"notify.complete", "source.unsubscribe">>)
SourceError == Finish("error", "source.error", "error",
                      <<"notify.error", "source.unsubscribe">>)
Cancel == Finish("cancel", "cancel", "none", <<"source.unsubscribe">>)

\* A closed subscription has no further legal inputs. It can remain closed.
ClosedStutter == phase = "Closed" /\ UNCHANGED vars

Next == \/ Subscribe
        \/ \E value \in Values : SourceNext(value)
        \/ SourceComplete
        \/ SourceError
        \/ Cancel
        \/ ClosedStutter

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ phase \in {"Unsubscribed", "Active", "Closed"}
    /\ seen \in 0..Limit
    /\ received \in Seq(Values)
    /\ output \in Seq(Values)
    /\ Len(received) <= Limit
    /\ Len(output) <= Limit
    /\ notifications \in Seq({"next", "complete", "error"})
    /\ Len(notifications) <= Limit + 1
    /\ sourceConnected \in BOOLEAN
    /\ acquisitions \in 0..1
    /\ releases \in 0..1
    /\ closeReason \in {"none", "quota", "complete", "error", "cancel"}
    /\ lastEvent \in {"init", "subscribe", "source.next",
                       "source.complete", "source.error", "cancel"}
    /\ lastActions \in Seq({"notify.next", "notify.complete", "notify.error",
                            "source.subscribe", "source.unsubscribe"})
    /\ Len(lastActions) <= 3

\* This is the property the deliberate extra-value mutation must violate.
QuotaBound == Len(output) <= Quota

ValuePreservation == output = received

OutputAccounting ==
    /\ Len(output) = seen
    /\ Cardinality({i \in 1..Len(notifications) : notifications[i] = "next"}) = seen

\* Every notification before the last one is a next notification.
\* Therefore complete/error is unique, terminal, and mutually exclusive.
NotificationProtocol ==
    \A i \in 1..Len(notifications) :
        i < Len(notifications) => notifications[i] = "next"

SourceLifetime ==
    /\ sourceConnected = (phase = "Active")
    /\ acquisitions - releases = IF sourceConnected THEN 1 ELSE 0

ZeroNeverSubscribes == Quota = 0 => acquisitions = 0

AllNext == \A i \in 1..Len(notifications) : notifications[i] = "next"
EndsWith(kind) == /\ Len(notifications) > 0
                  /\ notifications[Len(notifications)] = kind

ClosureAgrees ==
    /\ (phase # "Closed" => closeReason = "none" /\ AllNext)
    /\ (phase = "Closed" =>
          CASE closeReason \in {"quota", "complete"} -> EndsWith("complete")
            [] closeReason = "error" -> EndsWith("error")
            [] closeReason = "cancel" -> AllNext
            [] OTHER -> FALSE)

QuotaCompletion == closeReason = "quota" => Len(output) = Quota

=============================================================================
