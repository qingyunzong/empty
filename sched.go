// Package batchsched implements a deficit-round-robin batch scheduler.
//
// Tenants are polled in round-robin order. Each round a tenant with pending
// work receives a fixed integer quantum of credit (its deficit). A queued
// task is dispatched only when its cost fits within the tenant's deficit, so
// tasks larger than one quantum accumulate credit across rounds. A tenant
// whose queue drains has its deficit reset to zero: idle tenants cannot bank
// credit. Up to urgentPerRound urgent tasks bypass the deficit machinery each
// round. Fees are charged exactly once, at dispatch time, so cancelling a
// pending task can never leave a phantom charge.
package batchsched

import (
	"container/list"
	"fmt"
	"sort"
)

// Task is a unit of batch work. Cost is the integer fee charged to the
// tenant at dispatch. Urgent tasks are dispatched from a global FIFO
// backlog, at most urgentPerRound per round, ahead of regular polling.
type Task struct {
	ID     int
	Tenant string
	Cost   int
	Urgent bool
}

// Completion records that a task was dispatched in a given round.
type Completion struct {
	Task  Task
	Round int
}

// OpKind distinguishes replay operations.
type OpKind int

const (
	OpSubmit OpKind = iota
	OpCancel
)

// Op is a replay log entry applied on the virtual clock: after round At has
// completed and before round At+1 runs.
type Op struct {
	At     int
	Kind   OpKind
	Task   Task // for OpSubmit
	TaskID int  // for OpCancel
}

type tenant struct {
	deficit int
	queue   *list.List // of Task
}

// Scheduler is a single-threaded DRR batch scheduler driven by a virtual
// clock whose unit is the round.
type Scheduler struct {
	quantum        int
	urgentPerRound int
	round          int

	tenants map[string]*tenant
	order   []string // round-robin order, by first submission
	cursor  int      // index into order where the next poll starts
	urgent  *list.List
	pending map[int]*list.Element // task ID -> element in urgent or tenant queue

	fees      map[string]int
	completed []Completion
}

// New returns a Scheduler. quantum is the integer credit added per tenant
// per round; urgentPerRound caps urgent dispatches each round.
func New(quantum, urgentPerRound int) *Scheduler {
	if quantum <= 0 {
		panic("batchsched: quantum must be positive")
	}
	if urgentPerRound < 0 {
		panic("batchsched: urgentPerRound must be non-negative")
	}
	return &Scheduler{
		quantum:        quantum,
		urgentPerRound: urgentPerRound,
		tenants:        make(map[string]*tenant),
		urgent:         list.New(),
		pending:        make(map[int]*list.Element),
		fees:           make(map[string]int),
	}
}

// Submit enqueues a task. It panics on a non-positive cost, an empty tenant,
// or a duplicate task ID.
func (s *Scheduler) Submit(t Task) {
	if t.Cost <= 0 {
		panic(fmt.Sprintf("batchsched: task %d has non-positive cost %d", t.ID, t.Cost))
	}
	if t.Tenant == "" {
		panic(fmt.Sprintf("batchsched: task %d has empty tenant", t.ID))
	}
	if _, dup := s.pending[t.ID]; dup {
		panic(fmt.Sprintf("batchsched: duplicate task ID %d", t.ID))
	}
	if t.Urgent {
		s.pending[t.ID] = s.urgent.PushBack(t)
		return
	}
	tn, ok := s.tenants[t.Tenant]
	if !ok {
		tn = &tenant{queue: list.New()}
		s.tenants[t.Tenant] = tn
		s.order = append(s.order, t.Tenant)
	}
	s.pending[t.ID] = tn.queue.PushBack(t)
}

// Cancel removes a pending task. It reports whether the task was still
// pending. No fee is ever charged for a cancelled task: fees accrue only at
// dispatch, so cancellation cannot leave a phantom charge.
func (s *Scheduler) Cancel(id int) bool {
	e, ok := s.pending[id]
	if !ok {
		return false
	}
	t := e.Value.(Task)
	if t.Urgent {
		s.urgent.Remove(e)
	} else {
		tn := s.tenants[t.Tenant]
		tn.queue.Remove(e)
		if tn.queue.Len() == 0 {
			// Keep the invariant "empty queue => zero deficit" so that
			// Advance may fast-forward idle rounds safely.
			tn.deficit = 0
		}
	}
	delete(s.pending, id)
	return true
}

// RunRound advances the virtual clock by one round: up to urgentPerRound
// urgent tasks are dispatched, then every tenant is polled once in
// round-robin order, receiving its quantum and dispatching every queued
// task that fits within its accumulated deficit.
func (s *Scheduler) RunRound() {
	s.round++
	for i := 0; i < s.urgentPerRound && s.urgent.Len() > 0; i++ {
		e := s.urgent.Front()
		s.urgent.Remove(e)
		t := e.Value.(Task)
		delete(s.pending, t.ID)
		s.dispatch(t)
	}
	n := len(s.order)
	if n == 0 {
		return
	}
	for i := 0; i < n; i++ {
		tn := s.tenants[s.order[(s.cursor+i)%n]]
		if tn.queue.Len() == 0 {
			tn.deficit = 0
			continue
		}
		tn.deficit += s.quantum
		for tn.queue.Len() > 0 {
			e := tn.queue.Front()
			t := e.Value.(Task)
			if t.Cost > tn.deficit {
				break
			}
			tn.deficit -= t.Cost
			tn.queue.Remove(e)
			delete(s.pending, t.ID)
			s.dispatch(t)
		}
		if tn.queue.Len() == 0 {
			tn.deficit = 0
		}
	}
	s.cursor = (s.cursor + 1) % n
}

// Advance runs rounds until the virtual clock reaches the given round.
// When nothing is pending, rounds have no observable effect (idle tenants
// hold zero deficit), so the clock fast-forwards without simulating them;
// only the round-robin cursor rotation of the skipped rounds is applied.
func (s *Scheduler) Advance(to int) {
	if to < s.round {
		panic(fmt.Sprintf("batchsched: cannot rewind virtual clock from %d to %d", s.round, to))
	}
	for s.round < to {
		if len(s.pending) == 0 {
			if n := len(s.order); n > 0 {
				s.cursor = (s.cursor + (to - s.round)) % n
			}
			s.round = to
			return
		}
		s.RunRound()
	}
}

// Replay applies an operation log on the virtual clock: each op is applied
// after round op.At completes, then the clock advances until round `until`.
func (s *Scheduler) Replay(ops []Op, until int) {
	sorted := make([]Op, len(ops))
	copy(sorted, ops)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].At < sorted[j].At })
	for _, op := range sorted {
		s.Advance(op.At)
		switch op.Kind {
		case OpSubmit:
			s.Submit(op.Task)
		case OpCancel:
			s.Cancel(op.TaskID)
		}
	}
	s.Advance(until)
}

func (s *Scheduler) dispatch(t Task) {
	s.fees[t.Tenant] += t.Cost
	s.completed = append(s.completed, Completion{Task: t, Round: s.round})
}

// Round returns the current virtual clock value.
func (s *Scheduler) Round() int { return s.round }

// Pending reports how many tasks are still queued.
func (s *Scheduler) Pending() int { return len(s.pending) }

// Fees returns a copy of the per-tenant fee ledger.
func (s *Scheduler) Fees() map[string]int {
	out := make(map[string]int, len(s.fees))
	for k, v := range s.fees {
		out[k] = v
	}
	return out
}

// Completed returns a copy of the dispatch log in dispatch order.
func (s *Scheduler) Completed() []Completion {
	out := make([]Completion, len(s.completed))
	copy(out, s.completed)
	return out
}
