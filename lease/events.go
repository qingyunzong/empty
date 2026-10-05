package lease

import "fmt"

// Kind identifies a simulation event.
type Kind int

const (
	// EvGrant grants a fresh lease to Holder at At with TTL.
	EvGrant Kind = iota
	// EvRenew renews Holder's lease (presenting Fence) at At with TTL.
	EvRenew
	// EvSwitch performs a legal authoritative switch (old lease expired).
	EvSwitch
	// EvForceSwitch cuts authority over to Holder without notifying the
	// old holder (e.g. it is declared dead while partitioned).
	EvForceSwitch
	// EvPartition cuts Holder off from the manager and store: it keeps
	// its stale lease and may still attempt writes.
	EvPartition
	// EvHeal reconnects Holder.
	EvHeal
	// EvWrite is a write attempt by Holder with Fence at At.
	EvWrite
)

// Event is one step of a simulation script. Time is explicit: At is an
// integer tick and lease deadlines are exclusive.
type Event struct {
	Kind   Kind
	At     Time
	Holder string
	Fence  uint64 // presented by EvRenew / EvWrite
	TTL    uint64
	Data   string
}

// Outcome records what happened when an event was applied.
type Outcome struct {
	Event   Event
	Lease   Lease // lease produced by grant/renew/switch events
	Accept  bool  // write accepted (EvWrite only)
	Err     error // non-nil if the event was rejected
	Skipped bool  // holder was partitioned from the target
}

// Simulator replays event scripts against a Manager and Store while
// modelling network partitions. A partitioned holder cannot reach the
// manager or the store, but the manager may still force-switch away
// from it; the holder's later writes must then be rejected by fencing.
type Simulator struct {
	M *Manager
	S *Store

	partitioned map[string]bool
	outcomes    []Outcome
}

// NewSimulator returns a Simulator with a fresh Manager and Store.
func NewSimulator() *Simulator {
	m := NewManager()
	return &Simulator{M: m, S: NewStore(m), partitioned: map[string]bool{}}
}

// Apply executes one event and records its outcome.
func (sim *Simulator) Apply(ev Event) Outcome {
	oc := Outcome{Event: ev}
	switch ev.Kind {
	case EvPartition:
		sim.partitioned[ev.Holder] = true
	case EvHeal:
		delete(sim.partitioned, ev.Holder)
	case EvGrant:
		oc.Lease = sim.M.Grant(ev.Holder, ev.At, ev.TTL)
	case EvRenew:
		if sim.partitioned[ev.Holder] {
			oc.Skipped = true
			oc.Err = fmt.Errorf("lease: %q cannot reach manager (partitioned)", ev.Holder)
			break
		}
		oc.Lease, oc.Err = sim.M.Renew(ev.Holder, ev.Fence, ev.At, ev.TTL)
	case EvSwitch:
		oc.Lease, oc.Err = sim.M.Switch(ev.Holder, ev.At, ev.TTL)
	case EvForceSwitch:
		oc.Lease = sim.M.ForceSwitch(ev.Holder, ev.At, ev.TTL)
	case EvWrite:
		if sim.partitioned[ev.Holder] {
			// The holder still tries to write; a real client cannot
			// reach the store, so the attempt is dropped on the floor.
			oc.Skipped = true
			oc.Err = fmt.Errorf("lease: %q cannot reach store (partitioned)", ev.Holder)
			break
		}
		oc.Err = sim.S.Write(ev.Holder, ev.Fence, ev.At, ev.Data)
		oc.Accept = oc.Err == nil
	}
	sim.outcomes = append(sim.outcomes, oc)
	return oc
}

// Replay resets the simulator and applies the script in order.
func (sim *Simulator) Replay(script []Event) []Outcome {
	fresh := NewSimulator()
	*sim = *fresh
	for _, ev := range script {
		sim.Apply(ev)
	}
	return sim.outcomes
}

// Outcomes returns the recorded outcomes.
func (sim *Simulator) Outcomes() []Outcome { return append([]Outcome(nil), sim.outcomes...) }

// Conflict describes two accepted writes by different holders whose
// lease validity intervals overlap: a double-legal-write violation.
type Conflict struct {
	A, B Write
}

// Conflicts examines accepted writes and returns every pair written by
// different holders where each write happened inside the other write's
// lease validity interval. An empty result means the fencing invariant
// held: at no instant were two holders both legally able to write.
// (Lease intervals themselves may overlap after a force-switch; what
// must never happen is both holders actually writing during the
// overlap.)
func Conflicts(writes []Write) []Conflict {
	var out []Conflict
	for i := 0; i < len(writes); i++ {
		for j := i + 1; j < len(writes); j++ {
			a, b := writes[i], writes[j]
			if a.Holder == b.Holder {
				continue
			}
			aInB := b.LeaseStart <= a.At && a.At < b.LeaseExpiry
			bInA := a.LeaseStart <= b.At && b.At < a.LeaseExpiry
			if aInB && bInA {
				out = append(out, Conflict{A: a, B: b})
			}
		}
	}
	return out
}
