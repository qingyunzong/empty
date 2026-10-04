// Package sim implements a discrete-time thread scheduler simulator with
// mutexes, transitive priority inheritance, and deadlock detection.
//
// Each tick the scheduler picks the ready thread with the highest effective
// priority (ties broken by smallest thread ID) and executes one operation of
// its program. Effective priorities are recomputed from the full wait-for
// graph after every state change. If the wait-for graph contains a cycle,
// the simulator reports the cycle as a DeadlockError instead of continuing.
package sim

import (
	"fmt"
	"strconv"
	"strings"
)

// OpKind is the kind of a program operation.
type OpKind int

const (
	OpLock OpKind = iota
	OpUnlock
)

// Op is a single program operation, executed in one tick.
type Op struct {
	Kind  OpKind
	Mutex int
}

// Lock returns an Op that acquires mutex m, blocking if it is held.
func Lock(m int) Op { return Op{Kind: OpLock, Mutex: m} }

// Unlock returns an Op that releases mutex m, which must be held by the
// executing thread.
func Unlock(m int) Op { return Op{Kind: OpUnlock, Mutex: m} }

// Thread is a simulated thread running a fixed program of ops.
type Thread struct {
	ID       int
	BasePrio int
	Start    int // arrival tick; not schedulable before this tick
	Prog     []Op

	pc        int
	eff       int
	blockedOn int // mutex ID the thread waits on, -1 when ready
	done      bool
}

// NewThread creates a thread with the given ID, base priority, arrival tick
// and program.
func NewThread(id, prio, start int, prog ...Op) *Thread {
	return &Thread{ID: id, BasePrio: prio, Start: start, Prog: prog, blockedOn: -1}
}

// Event records one scheduler action for later inspection.
type Event struct {
	Tick   int
	Thread int
	Action string
}

// DeadlockError is returned when the wait-for graph contains a cycle.
type DeadlockError struct {
	Cycle []int // thread IDs forming the wait cycle, smallest ID first
}

func (e *DeadlockError) Error() string {
	ids := make([]string, len(e.Cycle))
	for i, id := range e.Cycle {
		ids[i] = strconv.Itoa(id)
	}
	return "deadlock: wait cycle " + strings.Join(ids, " -> ")
}

type mutexState struct {
	owner int // owning thread ID, -1 when free
}

// Sim is the simulator state.
type Sim struct {
	threads []*Thread
	byID    map[int]*Thread
	mutexes map[int]*mutexState
	tick    int
	Events  []Event
}

// New creates a simulator for the given threads.
func New(threads ...*Thread) *Sim {
	s := &Sim{
		byID:    make(map[int]*Thread, len(threads)),
		mutexes: map[int]*mutexState{},
	}
	for _, t := range threads {
		t.blockedOn = -1 // threads always start ready
		t.eff = t.BasePrio
		s.threads = append(s.threads, t)
		s.byID[t.ID] = t
	}
	return s
}

// Tick returns the current tick number.
func (s *Sim) Tick() int { return s.tick }

// Effective returns the current effective priority of the thread.
func (s *Sim) Effective(id int) int { return s.byID[id].eff }

// Done reports whether every thread has finished its program.
func (s *Sim) Done() bool {
	for _, t := range s.threads {
		if !t.done {
			return false
		}
	}
	return true
}

// mutex returns the state for mutex m, creating it on first use.
func (s *Sim) mutex(m int) *mutexState {
	ms, ok := s.mutexes[m]
	if !ok {
		ms = &mutexState{owner: -1}
		s.mutexes[m] = ms
	}
	return ms
}

// waitTarget returns the ID of the thread that t waits on, or -1.
func (s *Sim) waitTarget(t *Thread) int {
	if t.blockedOn < 0 {
		return -1
	}
	return s.mutexes[t.blockedOn].owner
}

// recompute recomputes every effective priority from scratch by propagating
// priorities along the full wait-for graph until a fixpoint is reached.
// This full-graph recompute is the single source of truth: nothing updates
// effective priorities incrementally.
func (s *Sim) recompute() {
	for _, t := range s.threads {
		t.eff = t.BasePrio
	}
	for changed := true; changed; {
		changed = false
		for _, w := range s.threads {
			h := s.waitTarget(w)
			if h < 0 {
				continue
			}
			if holder := s.byID[h]; holder.eff < w.eff {
				holder.eff = w.eff
				changed = true
			}
		}
	}
}

// findCycle returns one wait-for cycle (thread IDs, smallest first) or nil.
// Every thread has at most one outgoing wait edge, so cycles are found by
// walking successor chains.
func (s *Sim) findCycle() []int {
	for _, start := range s.threads {
		seen := map[int]int{}
		id := start.ID
		for id >= 0 {
			if idx, ok := seen[id]; ok {
				cycle := []int{}
				cur := start.ID
				for i := 0; i < idx; i++ {
					cur = s.waitTarget(s.byID[cur])
				}
				first := cur
				for {
					cycle = append(cycle, cur)
					cur = s.waitTarget(s.byID[cur])
					if cur == first {
						break
					}
				}
				// Rotate so the smallest ID comes first, for a
				// deterministic report.
				min := 0
				for i, v := range cycle {
					if v < cycle[min] {
						min = i
					}
				}
				return append(cycle[min:], cycle[:min]...)
			}
			seen[id] = len(seen)
			id = s.waitTarget(s.byID[id])
		}
	}
	return nil
}

// Step advances the simulation by one tick. It returns done=true when all
// threads have finished, or a *DeadlockError when a wait cycle exists.
func (s *Sim) Step() (done bool, err error) {
	s.recompute()
	if cycle := s.findCycle(); cycle != nil {
		return false, &DeadlockError{Cycle: cycle}
	}
	if s.Done() {
		return true, nil
	}

	// Pick the ready thread with the highest effective priority,
	// breaking ties by smallest ID.
	var pick *Thread
	for _, t := range s.threads {
		if t.done || t.blockedOn >= 0 || s.tick < t.Start {
			continue
		}
		if pick == nil || t.eff > pick.eff || (t.eff == pick.eff && t.ID < pick.ID) {
			pick = t
		}
	}
	if pick == nil {
		// No ready thread but not all done: every remaining thread is
		// blocked, and blocked threads always wait on an owner, so a
		// cycle must exist. Guard anyway.
		if cycle := s.findCycle(); cycle != nil {
			return false, &DeadlockError{Cycle: cycle}
		}
		return false, fmt.Errorf("tick %d: no schedulable thread", s.tick)
	}

	op := pick.Prog[pick.pc]
	switch op.Kind {
	case OpLock:
		ms := s.mutex(op.Mutex)
		if ms.owner == -1 {
			ms.owner = pick.ID
			pick.pc++
			s.log(pick, fmt.Sprintf("lock m%d", op.Mutex))
		} else if ms.owner == pick.ID {
			return false, fmt.Errorf("tick %d: thread %d re-locks held mutex m%d", s.tick, pick.ID, op.Mutex)
		} else {
			pick.blockedOn = op.Mutex
			s.log(pick, fmt.Sprintf("block m%d (held by %d)", op.Mutex, ms.owner))
		}
	case OpUnlock:
		ms := s.mutex(op.Mutex)
		if ms.owner != pick.ID {
			return false, fmt.Errorf("tick %d: thread %d unlocks mutex m%d it does not hold", s.tick, pick.ID, op.Mutex)
		}
		s.release(pick, op.Mutex)
		pick.pc++
		s.log(pick, fmt.Sprintf("unlock m%d", op.Mutex))
	}

	if pick.pc == len(pick.Prog) {
		pick.done = true
		// Auto-release any mutexes still held by the finished thread.
		for m, ms := range s.mutexes {
			if ms.owner == pick.ID {
				s.release(pick, m)
			}
		}
	}

	// Recompute after the state change (in particular after releases) so
	// inherited priorities are dropped or propagated immediately.
	s.recompute()
	s.tick++
	return s.Done(), nil
}

// release frees mutex m held by t and wakes all its waiters; they retry the
// lock when next scheduled.
func (s *Sim) release(t *Thread, m int) {
	s.mutexes[m].owner = -1
	for _, w := range s.threads {
		if w.blockedOn == m {
			w.blockedOn = -1
		}
	}
}

func (s *Sim) log(t *Thread, action string) {
	s.Events = append(s.Events, Event{Tick: s.tick, Thread: t.ID, Action: action})
}

// Run steps the simulation to completion, returning a *DeadlockError if a
// wait cycle stops it.
func (s *Sim) Run() error {
	for {
		done, err := s.Step()
		if err != nil {
			return err
		}
		if done {
			return nil
		}
	}
}
