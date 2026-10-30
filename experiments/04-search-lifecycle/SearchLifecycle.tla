--------------------------- MODULE SearchLifecycle ---------------------------
EXTENDS Integers, FiniteSets

CONSTANTS Policy, TimerOrder, Delay, Horizon, MaxQueries
ASSUME /\ Policy \in {"debounced", "immediate"}
       /\ TimerOrder \in {"external-first", "timer-first"}
       /\ Delay \in Nat \ {0}
       /\ Horizon \in Nat
       /\ Horizon >= Delay
       /\ MaxQueries \in Nat \ {0}

VARIABLES now, phase, latestRaw, pending, deadline, active,
          sourceState, destinationState, started, stopped, delivered,
          terminalCount, badEmission, lastTimerAt,
          completionFlushed, completionDeferred, sourceErrorDiscardedPending,
          innerErrored, boundaryQueryAfterStart,
          lastEvent, lastId, lastStartedId, lastStoppedId, lastStopReason,
          lastOutputId, lastTerminal

state == <<now, phase, latestRaw, pending, deadline, active,
           sourceState, destinationState, started, stopped, delivered,
           terminalCount, badEmission, lastTimerAt,
           completionFlushed, completionDeferred, sourceErrorDiscardedPending,
           innerErrored, boundaryQueryAfterStart>>
observations == <<lastEvent, lastId, lastStartedId, lastStoppedId,
                  lastStopReason, lastOutputId, lastTerminal>>
vars == <<state, observations>>

Ids == 1..MaxQueries
FirstPhase == IF TimerOrder = "external-first" THEN "external" ELSE "timer"
ExternalAllowed == phase = "external" /\ destinationState = "open"
TimerDue == pending # 0 /\ deadline = now
StopSet(id) == IF id = 0 THEN {} ELSE {id}
StopReason(id, reason) == IF id = 0 THEN "none" ELSE reason

\* Observations describe a settled, non-reentrant reaction. A Result can produce
\* N then C; teardown inside that reaction is represented by the stopped ID.
Observe(event, id, startId, stopId, reason, outputId, terminal) ==
  /\ lastEvent' = event
  /\ lastId' = id
  /\ lastStartedId' = startId
  /\ lastStoppedId' = stopId
  /\ lastStopReason' = StopReason(stopId, reason)
  /\ lastOutputId' = outputId
  /\ lastTerminal' = terminal

Init ==
  /\ now = 0
  /\ phase = FirstPhase
  /\ latestRaw = 0
  /\ pending = 0
  /\ deadline = -1
  /\ active = 0
  /\ sourceState = "open"
  /\ destinationState = "open"
  /\ started = {}
  /\ stopped = {}
  /\ delivered = {}
  /\ terminalCount = 0
  /\ badEmission = FALSE
  /\ lastTimerAt = -1
  /\ completionFlushed = FALSE
  /\ completionDeferred = FALSE
  /\ sourceErrorDiscardedPending = FALSE
  /\ innerErrored = FALSE
  /\ boundaryQueryAfterStart = FALSE
  /\ lastEvent = "Init"
  /\ lastId = 0
  /\ lastStartedId = 0
  /\ lastStoppedId = 0
  /\ lastStopReason = "none"
  /\ lastOutputId = 0
  /\ lastTerminal = "none"

Query ==
  /\ ExternalAllowed /\ sourceState = "open"
  /\ latestRaw < MaxQueries
  /\ latestRaw' = latestRaw + 1
  /\ pending' = latestRaw + 1
  /\ deadline' = now + Delay
  /\ active' = IF Policy = "immediate" THEN 0 ELSE active
  /\ stopped' = stopped \cup IF Policy = "immediate" THEN StopSet(active) ELSE {}
  /\ boundaryQueryAfterStart' = (boundaryQueryAfterStart \/ (lastTimerAt = now /\ active # 0))
  /\ Observe("Query", latestRaw + 1, 0,
             IF Policy = "immediate" THEN active ELSE 0, "unsubscribe", 0, "none")
  /\ UNCHANGED <<now, phase, sourceState, destinationState, started, delivered,
                  terminalCount, badEmission, lastTimerAt, completionFlushed,
                  completionDeferred, sourceErrorDiscardedPending, innerErrored>>

Timer ==
  /\ phase = "timer" /\ destinationState = "open" /\ TimerDue
  /\ active' = pending
  /\ started' = started \cup {pending}
  /\ stopped' = stopped \cup StopSet(active)
  /\ pending' = 0
  /\ deadline' = -1
  /\ lastTimerAt' = now
  /\ Observe("Timer", pending, pending, active, "unsubscribe", 0, "none")
  /\ UNCHANGED <<now, phase, latestRaw, sourceState, destinationState, delivered,
                  terminalCount, badEmission, completionFlushed, completionDeferred,
                  sourceErrorDiscardedPending, innerErrored, boundaryQueryAfterStart>>

Result ==
  /\ ExternalAllowed /\ active # 0
  /\ LET completes == sourceState = "completed" /\ pending = 0
     IN /\ destinationState' = IF completes THEN "completed" ELSE "open"
        /\ terminalCount' = IF completes THEN terminalCount + 1 ELSE terminalCount
        /\ Observe("Result", active, 0, active, "complete", active,
                   IF completes THEN "C" ELSE "none")
  /\ delivered' = delivered \cup {active}
  /\ stopped' = stopped \cup {active}
  /\ active' = 0
  /\ badEmission' = (badEmission \/ (active # latestRaw))
  /\ UNCHANGED <<now, phase, latestRaw, pending, deadline, sourceState, started,
                  lastTimerAt, completionFlushed, completionDeferred,
                  sourceErrorDiscardedPending, innerErrored, boundaryQueryAfterStart>>

SourceComplete ==
  /\ ExternalAllowed /\ sourceState = "open"
  /\ LET flush == Policy = "debounced" /\ pending # 0
         nextActive == IF flush THEN pending ELSE active
         nextPending == IF flush THEN 0 ELSE pending
         completes == nextActive = 0 /\ nextPending = 0
     IN /\ active' = nextActive
        /\ pending' = nextPending
        /\ deadline' = IF flush THEN -1 ELSE deadline
        /\ started' = started \cup IF flush THEN {pending} ELSE {}
        /\ stopped' = stopped \cup IF flush THEN StopSet(active) ELSE {}
        /\ completionFlushed' = (completionFlushed \/ flush)
        /\ completionDeferred' = (completionDeferred \/ (Policy = "immediate" /\ pending # 0))
        /\ destinationState' = IF completes THEN "completed" ELSE "open"
        /\ terminalCount' = IF completes THEN terminalCount + 1 ELSE terminalCount
        /\ Observe("SourceComplete", 0, IF flush THEN pending ELSE 0,
                   IF flush THEN active ELSE 0, "unsubscribe", 0,
                   IF completes THEN "C" ELSE "none")
  /\ sourceState' = "completed"
  /\ UNCHANGED <<now, phase, latestRaw, delivered, badEmission, lastTimerAt,
                  sourceErrorDiscardedPending, innerErrored, boundaryQueryAfterStart>>

SourceError ==
  /\ ExternalAllowed /\ sourceState = "open"
  /\ sourceState' = "errored"
  /\ destinationState' = "errored"
  /\ pending' = 0
  /\ deadline' = -1
  /\ active' = 0
  /\ stopped' = stopped \cup StopSet(active)
  /\ terminalCount' = terminalCount + 1
  /\ sourceErrorDiscardedPending' = (sourceErrorDiscardedPending \/ (pending # 0))
  /\ Observe("SourceError", 0, 0, active, "unsubscribe", 0, "E")
  /\ UNCHANGED <<now, phase, latestRaw, started, delivered, badEmission, lastTimerAt,
                  completionFlushed, completionDeferred, innerErrored, boundaryQueryAfterStart>>

InnerError ==
  /\ ExternalAllowed /\ active # 0
  /\ sourceState' = IF sourceState = "open" THEN "unsubscribed" ELSE sourceState
  /\ destinationState' = "errored"
  /\ pending' = 0
  /\ deadline' = -1
  /\ active' = 0
  /\ stopped' = stopped \cup {active}
  /\ terminalCount' = terminalCount + 1
  /\ innerErrored' = TRUE
  /\ Observe("InnerError", active, 0, active, "error", 0, "E")
  /\ UNCHANGED <<now, phase, latestRaw, started, delivered, badEmission, lastTimerAt,
                  completionFlushed, completionDeferred, sourceErrorDiscardedPending,
                  boundaryQueryAfterStart>>

Cancel ==
  /\ ExternalAllowed
  /\ sourceState' = IF sourceState = "open" THEN "unsubscribed" ELSE sourceState
  /\ destinationState' = "cancelled"
  /\ pending' = 0
  /\ deadline' = -1
  /\ active' = 0
  /\ stopped' = stopped \cup StopSet(active)
  /\ Observe("Cancel", 0, 0, active, "unsubscribe", 0, "none")
  /\ UNCHANGED <<now, phase, latestRaw, started, delivered, terminalCount,
                  badEmission, lastTimerAt, completionFlushed, completionDeferred,
                  sourceErrorDiscardedPending, innerErrored, boundaryQueryAfterStart>>

EndExternal ==
  /\ phase = "external"
  /\ phase' = IF TimerOrder = "external-first" THEN "timer" ELSE "done"
  /\ Observe("EndExternal", 0, 0, 0, "none", 0, "none")
  /\ UNCHANGED <<now, latestRaw, pending, deadline, active, sourceState,
                  destinationState, started, stopped, delivered, terminalCount,
                  badEmission, lastTimerAt, completionFlushed, completionDeferred,
                  sourceErrorDiscardedPending, innerErrored, boundaryQueryAfterStart>>

EndTimer ==
  /\ phase = "timer" /\ ~TimerDue
  /\ phase' = IF TimerOrder = "external-first" THEN "done" ELSE "external"
  /\ Observe("EndTimer", 0, 0, 0, "none", 0, "none")
  /\ UNCHANGED <<now, latestRaw, pending, deadline, active, sourceState,
                  destinationState, started, stopped, delivered, terminalCount,
                  badEmission, lastTimerAt, completionFlushed, completionDeferred,
                  sourceErrorDiscardedPending, innerErrored, boundaryQueryAfterStart>>

Tick ==
  /\ phase = "done" /\ now < Horizon
  /\ now' = now + 1
  /\ phase' = FirstPhase
  /\ Observe("Tick", 0, 0, 0, "none", 0, "none")
  /\ UNCHANGED <<latestRaw, pending, deadline, active, sourceState,
                  destinationState, started, stopped, delivered, terminalCount,
                  badEmission, lastTimerAt, completionFlushed, completionDeferred,
                  sourceErrorDiscardedPending, innerErrored, boundaryQueryAfterStart>>

\* The horizon stutters only after the frame's timer/external phases are settled.
HorizonStop == now = Horizon /\ phase = "done" /\ UNCHANGED vars
Next == Query \/ Timer \/ Result \/ SourceComplete \/ SourceError \/ InnerError
        \/ Cancel \/ EndExternal \/ EndTimer \/ Tick \/ HorizonStop
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ now \in 0..Horizon
  /\ phase \in {"external", "timer", "done"}
  /\ latestRaw \in 0..MaxQueries
  /\ pending \in 0..MaxQueries
  /\ active \in 0..MaxQueries
  /\ deadline \in {-1} \cup (0..(Horizon + Delay))
  /\ sourceState \in {"open", "completed", "errored", "unsubscribed"}
  /\ destinationState \in {"open", "completed", "errored", "cancelled"}
  /\ started \subseteq Ids
  /\ stopped \subseteq started
  /\ delivered \subseteq stopped
  /\ terminalCount \in {0, 1}
  /\ badEmission \in BOOLEAN
  /\ lastTimerAt \in {-1} \cup (0..Horizon)
  /\ completionFlushed \in BOOLEAN
  /\ completionDeferred \in BOOLEAN
  /\ sourceErrorDiscardedPending \in BOOLEAN
  /\ innerErrored \in BOOLEAN
  /\ boundaryQueryAfterStart \in BOOLEAN
  /\ lastEvent \in {"Init", "Query", "Timer", "Result", "SourceComplete", "SourceError",
                     "InnerError", "Cancel", "EndExternal", "EndTimer", "Tick"}
  /\ lastId \in 0..MaxQueries
  /\ lastStartedId \in 0..MaxQueries
  /\ lastStoppedId \in 0..MaxQueries
  /\ lastStopReason \in {"none", "complete", "error", "unsubscribe"}
  /\ lastOutputId \in 0..MaxQueries
  /\ lastTerminal \in {"none", "C", "E"}

OwnedWork == destinationState # "open" => (pending = 0 /\ active = 0 /\ deadline = -1)
PendingClock == (pending = 0) <=> (deadline = -1)
ActiveAccounting == started \ stopped = StopSet(active)
SourceOwnership == destinationState # "open" => sourceState # "open"
TerminalProtocol == (destinationState \in {"completed", "errored"}) <=> (terminalCount = 1)
CompletionAgrees ==
  /\ (destinationState = "completed" => sourceState = "completed")
  /\ (sourceState = "completed" /\ pending = 0 /\ active = 0 => destinationState # "open")
ErrorAgrees == sourceState = "errored" => destinationState = "errored"
ErrorReaction == lastEvent \in {"SourceError", "InnerError"} =>
  (lastStartedId = 0 /\ lastOutputId = 0 /\ lastTerminal = "E")
FreshEmission == ~badEmission

\* These false-invariant checks are reachability witnesses, not liveness claims.
NoCompletionFlush == ~completionFlushed
NoDeferredCompletion == ~completionDeferred
NoSourceErrorDiscard == ~sourceErrorDiscardedPending
NoInnerError == ~innerErrored
NoBoundaryStart == ~boundaryQueryAfterStart
NoResultCompletion == ~(lastEvent = "Result" /\ lastTerminal = "C")
=============================================================================
