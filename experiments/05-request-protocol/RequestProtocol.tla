--------------------------- MODULE RequestProtocol ---------------------------
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS Policy, TimerOrder, Delay, Horizon, MaxQueries, MaxValues, CompleteOnNext
ASSUME /\ Policy \in {"debounced", "immediate"}
       /\ TimerOrder \in {"external-first", "timer-first"}
       /\ Delay \in Nat \ {0}
       /\ Horizon \in Nat
       /\ Horizon >= Delay
       /\ MaxQueries \in Nat \ {0}
       /\ MaxValues \in Nat \ {0}
       /\ CompleteOnNext \in BOOLEAN

\* CompleteOnNext is a named model mutation. Correct configurations keep it
\* FALSE. Closing a request after its first next must violate the unchanged
\* NextKeepsRequestActive requirement, even if other ownership rules still hold.
VARIABLES now, phase, latestRaw, pending, deadline, active, activeNextCount,
          sourceState, destinationState, started, stopped,
          completedRequests, erroredRequests, cancelledRequests, nextCounts,
          acceptedNexts, outputHistory, terminalCount, closedOutputLength,
          badEmission,
          lastEvent, lastId, lastStartedId, lastStoppedId, lastStopReason,
          lastOutputId, lastOutputIndex, lastTerminal

state == <<now, phase, latestRaw, pending, deadline, active, activeNextCount,
           sourceState, destinationState, started, stopped,
           completedRequests, erroredRequests, cancelledRequests, nextCounts,
           acceptedNexts, outputHistory, terminalCount, closedOutputLength,
           badEmission>>
observations == <<lastEvent, lastId, lastStartedId, lastStoppedId,
                  lastStopReason, lastOutputId, lastOutputIndex, lastTerminal>>
vars == <<state, observations>>

Ids == 1..MaxQueries
Tokens == Ids \X (1..MaxValues)
FirstPhase == IF TimerOrder = "external-first" THEN "external" ELSE "timer"
ExternalAllowed == phase = "external" /\ destinationState = "open"
TimerDue == pending # 0 /\ deadline = now
StopSet(id) == IF id = 0 THEN {} ELSE {id}
StopReason(id, reason) == IF id = 0 THEN "none" ELSE reason

\* Each next has an opaque identity <<request ID, ordinal>>. Payload contents
\* do not affect either pipeline and are checked separately by the RxJS tests.
\* Scalar observations describe a settled, non-reentrant reaction.
Observe(event, id, startId, stopId, reason, outputId, outputIndex, terminal) ==
  /\ lastEvent' = event
  /\ lastId' = id
  /\ lastStartedId' = startId
  /\ lastStoppedId' = stopId
  /\ lastStopReason' = StopReason(stopId, reason)
  /\ lastOutputId' = outputId
  /\ lastOutputIndex' = outputIndex
  /\ lastTerminal' = terminal

Init ==
  /\ now = 0
  /\ phase = FirstPhase
  /\ latestRaw = 0
  /\ pending = 0
  /\ deadline = -1
  /\ active = 0
  /\ activeNextCount = 0
  /\ sourceState = "open"
  /\ destinationState = "open"
  /\ started = {}
  /\ stopped = {}
  /\ completedRequests = {}
  /\ erroredRequests = {}
  /\ cancelledRequests = {}
  /\ nextCounts = [id \in Ids |-> 0]
  /\ acceptedNexts = <<>>
  /\ outputHistory = <<>>
  /\ terminalCount = 0
  /\ closedOutputLength = -1
  /\ badEmission = FALSE
  /\ lastEvent = "Init"
  /\ lastId = 0
  /\ lastStartedId = 0
  /\ lastStoppedId = 0
  /\ lastStopReason = "none"
  /\ lastOutputId = 0
  /\ lastOutputIndex = 0
  /\ lastTerminal = "none"

Query ==
  /\ ExternalAllowed /\ sourceState = "open"
  /\ latestRaw < MaxQueries
  /\ latestRaw' = latestRaw + 1
  /\ pending' = latestRaw + 1
  /\ deadline' = now + Delay
  /\ active' = IF Policy = "immediate" THEN 0 ELSE active
  /\ activeNextCount' = IF Policy = "immediate" THEN 0 ELSE activeNextCount
  /\ stopped' = stopped \cup IF Policy = "immediate" THEN StopSet(active) ELSE {}
  /\ cancelledRequests' = cancelledRequests \cup IF Policy = "immediate" THEN StopSet(active) ELSE {}
  /\ Observe("Query", latestRaw + 1, 0,
             IF Policy = "immediate" THEN active ELSE 0, "unsubscribe", 0, 0, "none")
  /\ UNCHANGED <<now, phase, sourceState, destinationState, started,
                  completedRequests, erroredRequests, nextCounts,
                  acceptedNexts, outputHistory, terminalCount, closedOutputLength,
                  badEmission>>

Timer ==
  /\ phase = "timer" /\ destinationState = "open" /\ TimerDue
  /\ active' = pending
  /\ activeNextCount' = 0
  /\ started' = started \cup {pending}
  /\ stopped' = stopped \cup StopSet(active)
  /\ cancelledRequests' = cancelledRequests \cup StopSet(active)
  /\ pending' = 0
  /\ deadline' = -1
  /\ Observe("Timer", pending, pending, active, "unsubscribe", 0, 0, "none")
  /\ UNCHANGED <<now, phase, latestRaw, sourceState, destinationState,
                  completedRequests, erroredRequests, nextCounts,
                  acceptedNexts, outputHistory, terminalCount, closedOutputLength,
                  badEmission>>

InnerNext ==
  /\ ExternalAllowed /\ active # 0
  /\ nextCounts[active] < MaxValues
  /\ LET index == nextCounts[active] + 1
         closesOutput == CompleteOnNext /\ sourceState = "completed" /\ pending = 0
     IN /\ nextCounts' = [nextCounts EXCEPT ![active] = index]
        /\ acceptedNexts' = Append(acceptedNexts, <<active, index>>)
        /\ outputHistory' = Append(outputHistory, <<active, index>>)
        /\ active' = IF CompleteOnNext THEN 0 ELSE active
        /\ activeNextCount' = IF CompleteOnNext THEN 0 ELSE index
        /\ stopped' = stopped \cup IF CompleteOnNext THEN {active} ELSE {}
        /\ completedRequests' = completedRequests \cup IF CompleteOnNext THEN {active} ELSE {}
        /\ destinationState' = IF closesOutput THEN "completed" ELSE destinationState
        /\ terminalCount' = IF closesOutput THEN terminalCount + 1 ELSE terminalCount
        /\ closedOutputLength' = IF closesOutput THEN Len(outputHistory) + 1 ELSE closedOutputLength
        /\ Observe("InnerNext", active, 0, IF CompleteOnNext THEN active ELSE 0,
                   "complete", active, index, IF closesOutput THEN "C" ELSE "none")
  /\ badEmission' = (badEmission \/ (active # latestRaw))
  /\ UNCHANGED <<now, phase, latestRaw, pending, deadline, sourceState, started,
                  erroredRequests, cancelledRequests>>

InnerComplete ==
  /\ ExternalAllowed /\ active # 0
  /\ LET closesOutput == sourceState = "completed" /\ pending = 0
     IN /\ destinationState' = IF closesOutput THEN "completed" ELSE "open"
        /\ terminalCount' = IF closesOutput THEN terminalCount + 1 ELSE terminalCount
        /\ closedOutputLength' = IF closesOutput THEN Len(outputHistory) ELSE closedOutputLength
        /\ Observe("InnerComplete", active, 0, active, "complete", 0, 0,
                   IF closesOutput THEN "C" ELSE "none")
  /\ stopped' = stopped \cup {active}
  /\ completedRequests' = completedRequests \cup {active}
  /\ active' = 0
  /\ activeNextCount' = 0
  /\ UNCHANGED <<now, phase, latestRaw, pending, deadline, sourceState, started,
                  erroredRequests, cancelledRequests, nextCounts,
                  acceptedNexts, outputHistory, badEmission>>

SourceComplete ==
  /\ ExternalAllowed /\ sourceState = "open"
  /\ LET flush == Policy = "debounced" /\ pending # 0
         nextActive == IF flush THEN pending ELSE active
         nextPending == IF flush THEN 0 ELSE pending
         closesOutput == nextActive = 0 /\ nextPending = 0
     IN /\ active' = nextActive
        /\ activeNextCount' = IF flush THEN 0 ELSE activeNextCount
        /\ pending' = nextPending
        /\ deadline' = IF flush THEN -1 ELSE deadline
        /\ started' = started \cup IF flush THEN {pending} ELSE {}
        /\ stopped' = stopped \cup IF flush THEN StopSet(active) ELSE {}
        /\ cancelledRequests' = cancelledRequests \cup IF flush THEN StopSet(active) ELSE {}
        /\ destinationState' = IF closesOutput THEN "completed" ELSE "open"
        /\ terminalCount' = IF closesOutput THEN terminalCount + 1 ELSE terminalCount
        /\ closedOutputLength' = IF closesOutput THEN Len(outputHistory) ELSE closedOutputLength
        /\ Observe("SourceComplete", 0, IF flush THEN pending ELSE 0,
                   IF flush THEN active ELSE 0, "unsubscribe", 0, 0,
                   IF closesOutput THEN "C" ELSE "none")
  /\ sourceState' = "completed"
  /\ UNCHANGED <<now, phase, latestRaw, completedRequests, erroredRequests,
                  nextCounts, acceptedNexts, outputHistory, badEmission>>

SourceError ==
  /\ ExternalAllowed /\ sourceState = "open"
  /\ sourceState' = "errored"
  /\ destinationState' = "errored"
  /\ pending' = 0
  /\ deadline' = -1
  /\ active' = 0
  /\ activeNextCount' = 0
  /\ stopped' = stopped \cup StopSet(active)
  /\ cancelledRequests' = cancelledRequests \cup StopSet(active)
  /\ terminalCount' = terminalCount + 1
  /\ closedOutputLength' = Len(outputHistory)
  /\ Observe("SourceError", 0, 0, active, "unsubscribe", 0, 0, "E")
  /\ UNCHANGED <<now, phase, latestRaw, started, completedRequests, erroredRequests,
                  nextCounts, acceptedNexts, outputHistory, badEmission>>

InnerError ==
  /\ ExternalAllowed /\ active # 0
  /\ sourceState' = IF sourceState = "open" THEN "unsubscribed" ELSE sourceState
  /\ destinationState' = "errored"
  /\ pending' = 0
  /\ deadline' = -1
  /\ active' = 0
  /\ activeNextCount' = 0
  /\ stopped' = stopped \cup {active}
  /\ erroredRequests' = erroredRequests \cup {active}
  /\ terminalCount' = terminalCount + 1
  /\ closedOutputLength' = Len(outputHistory)
  /\ Observe("InnerError", active, 0, active, "error", 0, 0, "E")
  /\ UNCHANGED <<now, phase, latestRaw, started, completedRequests, cancelledRequests,
                  nextCounts, acceptedNexts, outputHistory, badEmission>>

Cancel ==
  /\ ExternalAllowed
  /\ sourceState' = IF sourceState = "open" THEN "unsubscribed" ELSE sourceState
  /\ destinationState' = "cancelled"
  /\ pending' = 0
  /\ deadline' = -1
  /\ active' = 0
  /\ activeNextCount' = 0
  /\ stopped' = stopped \cup StopSet(active)
  /\ cancelledRequests' = cancelledRequests \cup StopSet(active)
  /\ closedOutputLength' = Len(outputHistory)
  /\ Observe("Cancel", 0, 0, active, "unsubscribe", 0, 0, "none")
  /\ UNCHANGED <<now, phase, latestRaw, started, completedRequests, erroredRequests,
                  nextCounts, acceptedNexts, outputHistory, terminalCount, badEmission>>

EndExternal ==
  /\ phase = "external"
  /\ phase' = IF TimerOrder = "external-first" THEN "timer" ELSE "done"
  /\ Observe("EndExternal", 0, 0, 0, "none", 0, 0, "none")
  /\ UNCHANGED <<now, latestRaw, pending, deadline, active, activeNextCount,
                  sourceState, destinationState, started, stopped,
                  completedRequests, erroredRequests, cancelledRequests, nextCounts,
                  acceptedNexts, outputHistory, terminalCount, closedOutputLength, badEmission>>

EndTimer ==
  /\ phase = "timer" /\ ~TimerDue
  /\ phase' = IF TimerOrder = "external-first" THEN "done" ELSE "external"
  /\ Observe("EndTimer", 0, 0, 0, "none", 0, 0, "none")
  /\ UNCHANGED <<now, latestRaw, pending, deadline, active, activeNextCount,
                  sourceState, destinationState, started, stopped,
                  completedRequests, erroredRequests, cancelledRequests, nextCounts,
                  acceptedNexts, outputHistory, terminalCount, closedOutputLength, badEmission>>

Tick ==
  /\ phase = "done" /\ now < Horizon
  /\ now' = now + 1
  /\ phase' = FirstPhase
  /\ Observe("Tick", 0, 0, 0, "none", 0, 0, "none")
  /\ UNCHANGED <<latestRaw, pending, deadline, active, activeNextCount,
                  sourceState, destinationState, started, stopped,
                  completedRequests, erroredRequests, cancelledRequests, nextCounts,
                  acceptedNexts, outputHistory, terminalCount, closedOutputLength, badEmission>>

\* Tick requires both phases. A due timer is handled before EndTimer. The
\* horizon can leave later timers/requests pending; no fairness is assumed.
HorizonStop == now = Horizon /\ phase = "done" /\ UNCHANGED vars
Next == Query \/ Timer \/ InnerNext \/ InnerComplete \/ SourceComplete
        \/ SourceError \/ InnerError \/ Cancel \/ EndExternal \/ EndTimer
        \/ Tick \/ HorizonStop
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ now \in 0..Horizon
  /\ phase \in {"external", "timer", "done"}
  /\ latestRaw \in 0..MaxQueries
  /\ pending \in 0..MaxQueries
  /\ active \in 0..MaxQueries
  /\ activeNextCount \in 0..MaxValues
  /\ deadline \in {-1} \cup (0..(Horizon + Delay))
  /\ sourceState \in {"open", "completed", "errored", "unsubscribed"}
  /\ destinationState \in {"open", "completed", "errored", "cancelled"}
  /\ started \subseteq Ids
  /\ stopped \subseteq started
  /\ completedRequests \subseteq stopped
  /\ erroredRequests \subseteq stopped
  /\ cancelledRequests \subseteq stopped
  /\ nextCounts \in [Ids -> 0..MaxValues]
  /\ acceptedNexts \in Seq(Tokens)
  /\ outputHistory \in Seq(Tokens)
  /\ Len(acceptedNexts) <= MaxQueries * MaxValues
  /\ Len(outputHistory) <= MaxQueries * MaxValues
  /\ terminalCount \in {0, 1}
  /\ closedOutputLength \in {-1} \cup (0..(MaxQueries * MaxValues))
  /\ badEmission \in BOOLEAN
  /\ lastEvent \in {"Init", "Query", "Timer", "InnerNext", "InnerComplete",
                     "SourceComplete", "SourceError", "InnerError", "Cancel",
                     "EndExternal", "EndTimer", "Tick"}
  /\ lastId \in 0..MaxQueries
  /\ lastStartedId \in 0..MaxQueries
  /\ lastStoppedId \in 0..MaxQueries
  /\ lastStopReason \in {"none", "complete", "error", "unsubscribe"}
  /\ lastOutputId \in 0..MaxQueries
  /\ lastOutputIndex \in 0..MaxValues
  /\ lastTerminal \in {"none", "C", "E"}

OwnedWork == destinationState # "open" => (pending = 0 /\ active = 0 /\ deadline = -1)
PendingClock == (pending = 0) <=> (deadline = -1)
ActiveAccounting ==
  /\ started \ stopped = StopSet(active)
  /\ activeNextCount = IF active = 0 THEN 0 ELSE nextCounts[active]
RequestTermination ==
  /\ stopped = completedRequests \cup erroredRequests \cup cancelledRequests
  /\ completedRequests \intersect erroredRequests = {}
  /\ completedRequests \intersect cancelledRequests = {}
  /\ erroredRequests \intersect cancelledRequests = {}
SourceOwnership == destinationState # "open" => sourceState # "open"
TerminalProtocol == (destinationState \in {"completed", "errored"}) <=> (terminalCount = 1)
ClosedOutputStable == destinationState # "open" => Len(outputHistory) = closedOutputLength
CompletionAgrees ==
  /\ (destinationState = "completed" => sourceState = "completed")
  /\ (sourceState = "completed" /\ pending = 0 /\ active = 0 => destinationState # "open")
ErrorAgrees == sourceState = "errored" => destinationState = "errored"
ErrorReaction == lastEvent \in {"SourceError", "InnerError"} =>
  (lastStartedId = 0 /\ lastOutputId = 0 /\ lastOutputIndex = 0 /\ lastTerminal = "E")
NextKeepsRequestActive == lastEvent = "InnerNext" =>
  (active = lastId /\ active # 0 /\ destinationState = "open"
   /\ lastStoppedId = 0 /\ lastTerminal = "none")
CompleteDoesNotEmit == lastEvent = "InnerComplete" =>
  (lastOutputId = 0 /\ lastOutputIndex = 0 /\ lastStoppedId = lastId
   /\ lastStopReason = "complete" /\ lastId \in completedRequests)
OutputAccounting ==
  /\ outputHistory = acceptedNexts
  /\ \A id \in Ids : nextCounts[id] =
       Cardinality({i \in 1..Len(acceptedNexts) : acceptedNexts[i][1] = id})
  /\ \A id \in Ids \ started : nextCounts[id] = 0
OutputOrder == \A i \in 1..Len(outputHistory) :
  outputHistory[i][2] = Cardinality({j \in 1..i : outputHistory[j][1] = outputHistory[i][1]})
FreshEmission == ~badEmission

\* False-invariant reachability checks. Each is an existence witness, not an
\* eventual-result/termination guarantee. Inner-event endpoints are settled.
NoMultipleValues == ~(lastEvent = "InnerNext" /\ lastOutputIndex = MaxValues)
NoEmptyCompletion == ~(lastEvent = "InnerComplete" /\ lastTerminal = "C" /\ nextCounts[lastId] = 0)
NoNextAfterSourceComplete == ~(lastEvent = "InnerNext" /\ sourceState = "completed" /\ destinationState = "open")
NoMultiValueCompletion == ~(lastEvent = "InnerComplete" /\ lastTerminal = "C" /\ nextCounts[lastId] = MaxValues)
NoNextThenError == ~(lastEvent = "InnerError" /\ nextCounts[lastId] > 0)
NoSwitchAfterValue == ~(lastEvent = "Query" /\ lastStoppedId > 0 /\ nextCounts[lastStoppedId] > 0)
NoCancelAfterValue == ~(lastEvent = "Cancel" /\ lastStoppedId > 0 /\ nextCounts[lastStoppedId] > 0)
=============================================================================
