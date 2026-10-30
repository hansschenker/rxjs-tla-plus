-------------------------- MODULE SearchFreshness --------------------------
EXTENDS Integers, FiniteSets

CONSTANTS Policy, Delay, Horizon, MaxQueries
ASSUME /\ Policy \in {"debounced", "immediate"}
       /\ Delay > 0
       /\ Horizon >= Delay
       /\ MaxQueries > 0

VARIABLES now, latestRaw, pending, deadline, active, open, started,
          delivered, badEmission, lastTimerAt, lastEvent, lastId

vars == <<now, latestRaw, pending, deadline, active, open, started,
          delivered, badEmission, lastTimerAt, lastEvent, lastId>>

Ids == 1..MaxQueries

Init ==
  /\ now = 0
  /\ latestRaw = 0
  /\ pending = 0
  /\ deadline = -1
  /\ active = 0
  /\ open = TRUE
  /\ started = {}
  /\ delivered = {}
  /\ badEmission = FALSE
  /\ lastTimerAt = -1
  /\ lastEvent = "Init"
  /\ lastId = 0

TimerDue == pending # 0 /\ now = deadline

\* Scope: external notifications do not tie with a pending/firing timer.
\* External events at the same other time are ordered transitions.
ExternalAllowed == open /\ ~TimerDue /\ lastTimerAt # now

Query ==
  /\ ExternalAllowed
  /\ latestRaw < MaxQueries
  /\ latestRaw' = latestRaw + 1
  /\ pending' = latestRaw + 1
  /\ deadline' = now + Delay
  /\ active' = IF Policy = "immediate" THEN 0 ELSE active
  /\ lastEvent' = "Query"
  /\ lastId' = latestRaw + 1
  /\ UNCHANGED <<now, open, started, delivered, badEmission, lastTimerAt>>

Timer ==
  /\ open
  /\ TimerDue
  /\ active' = pending
  /\ started' = started \cup {pending}
  /\ pending' = 0
  /\ deadline' = -1
  /\ lastTimerAt' = now
  /\ lastEvent' = "Timer"
  /\ lastId' = pending
  /\ UNCHANGED <<now, latestRaw, open, delivered, badEmission>>

\* One result followed by successful inner completion, as one scoped reaction.
Result ==
  /\ ExternalAllowed
  /\ active # 0
  /\ delivered' = delivered \cup {active}
  /\ badEmission' = (badEmission \/ (active # latestRaw))
  /\ active' = 0
  /\ lastEvent' = "Result"
  /\ lastId' = active
  /\ UNCHANGED <<now, latestRaw, pending, deadline, open, started, lastTimerAt>>

Cancel ==
  /\ ExternalAllowed
  /\ open' = FALSE
  /\ pending' = 0
  /\ deadline' = -1
  /\ active' = 0
  /\ lastEvent' = "Cancel"
  /\ lastId' = 0
  /\ UNCHANGED <<now, latestRaw, started, delivered, badEmission, lastTimerAt>>

Tick ==
  /\ now < Horizon
  /\ ~TimerDue
  /\ now' = now + 1
  /\ lastEvent' = "Tick"
  /\ lastId' = 0
  /\ UNCHANGED <<latestRaw, pending, deadline, active, open, started,
                 delivered, badEmission, lastTimerAt>>

\* The finite horizon is intentional, not a liveness guarantee.
HorizonStop == now = Horizon /\ UNCHANGED vars
Next == Query \/ Timer \/ Result \/ Cancel \/ Tick \/ HorizonStop
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ now \in 0..Horizon
  /\ latestRaw \in 0..MaxQueries
  /\ pending \in 0..MaxQueries
  /\ active \in 0..MaxQueries
  /\ deadline \in {-1} \cup (0..(Horizon + Delay))
  /\ open \in BOOLEAN
  /\ started \subseteq Ids
  /\ delivered \subseteq started
  /\ badEmission \in BOOLEAN
  /\ lastTimerAt \in {-1} \cup (0..Horizon)
  /\ lastEvent \in {"Init", "Query", "Timer", "Result", "Cancel", "Tick"}
  /\ lastId \in 0..MaxQueries

OwnedWork == ~open => (pending = 0 /\ active = 0 /\ deadline = -1)
SelectedInner == active # 0 => active \in started
FreshEmission == ~badEmission
\* Intentionally false check: demonstrates that delivery is reachable.
NeverDelivers == delivered = {}
=============================================================================
