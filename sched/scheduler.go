// Package sched implements an event-stepped work-stealing scheduler
// simulator. Each worker owns a double-ended queue: the owner takes
// tasks from the tail, thieves steal from the head. Cancellation only
// takes effect while a task is still queued; once a take operation has
// succeeded the task is considered executed and cancellation is a no-op.
// All state transitions happen through discrete events, never real time.
package sched

import (
	"fmt"
	"strings"
	"sync"
)

// TaskState is the lifecycle state of a task.
type TaskState int

const (
	// Queued means the task sits in exactly one worker's deque.
	Queued TaskState = iota
	// Executed means a take operation (local pop or steal) succeeded.
	Executed
	// Cancelled means the task was cancelled while still queued.
	Cancelled
)

func (st TaskState) String() string {
	switch st {
	case Queued:
		return "queued"
	case Executed:
		return "executed"
	case Cancelled:
		return "cancelled"
	}
	return "unknown"
}

// deque is a double-ended queue of task IDs. Index 0 is the head
// (steal side); the last index is the tail (local pop side).
type deque struct {
	items []int
}

func (d *deque) pushTail(id int) { d.items = append(d.items, id) }

func (d *deque) popTail() (int, bool) {
	if len(d.items) == 0 {
		return 0, false
	}
	id := d.items[len(d.items)-1]
	d.items = d.items[:len(d.items)-1]
	return id, true
}

func (d *deque) popHead() (int, bool) {
	if len(d.items) == 0 {
		return 0, false
	}
	id := d.items[0]
	d.items = d.items[1:]
	return id, true
}

func (d *deque) remove(id int) bool {
	for i, v := range d.items {
		if v == id {
			d.items = append(d.items[:i], d.items[i+1:]...)
			return true
		}
	}
	return false
}

// Scheduler holds the deques and the task table. A mutex makes every
// take operation atomic, so two concurrent takes can never both win
// the same task.
type Scheduler struct {
	mu      sync.Mutex
	deques  []deque
	tasks   map[int]*taskRec
	execLog []int
}

type taskRec struct {
	state TaskState
	owner int // deque index while Queued, -1 otherwise
}

// New creates a scheduler with the given number of worker deques.
func New(workers int) *Scheduler {
	if workers <= 0 {
		panic("sched: need at least one worker")
	}
	return &Scheduler{
		deques: make([]deque, workers),
		tasks:  make(map[int]*taskRec),
	}
}

// Workers reports the number of worker deques.
func (s *Scheduler) Workers() int { return len(s.deques) }

// Submit pushes a task onto the tail of a worker's deque.
func (s *Scheduler) Submit(worker, id int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if worker < 0 || worker >= len(s.deques) {
		return fmt.Errorf("sched: worker %d out of range", worker)
	}
	if _, dup := s.tasks[id]; dup {
		return fmt.Errorf("sched: task %d already exists", id)
	}
	s.tasks[id] = &taskRec{state: Queued, owner: worker}
	s.deques[worker].pushTail(id)
	return nil
}

// take is the shared atomic core of PopLocal and Steal.
func (s *Scheduler) take(fromHead bool, victim int) (int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if victim < 0 || victim >= len(s.deques) {
		return 0, false
	}
	var (
		id int
		ok bool
	)
	if fromHead {
		id, ok = s.deques[victim].popHead()
	} else {
		id, ok = s.deques[victim].popTail()
	}
	if !ok {
		return 0, false
	}
	rec := s.tasks[id]
	rec.state = Executed
	rec.owner = -1
	s.execLog = append(s.execLog, id)
	return id, true
}

// PopLocal lets a worker take the tail task of its own deque.
// A successful take means the task executes in this step.
func (s *Scheduler) PopLocal(worker int) (int, bool) {
	return s.take(false, worker)
}

// Steal lets a thief take the head task of a victim's deque.
// A successful steal means the task executes in this step.
func (s *Scheduler) Steal(thief, victim int) (int, bool) {
	if thief == victim {
		return 0, false
	}
	return s.take(true, victim)
}

// Cancel cancels a queued task. It reports false and changes nothing
// if the task has already executed (or was already cancelled).
func (s *Scheduler) Cancel(id int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.tasks[id]
	if !ok || rec.state != Queued {
		return false
	}
	if !s.deques[rec.owner].remove(id) {
		panic("sched: queued task missing from its deque")
	}
	rec.state = Cancelled
	rec.owner = -1
	return true
}

// State reports the current state of a task.
func (s *Scheduler) State(id int) (TaskState, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.tasks[id]
	if !ok {
		return Queued, false
	}
	return rec.state, true
}

// Executed returns the IDs of executed tasks in execution order.
func (s *Scheduler) Executed() []int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]int(nil), s.execLog...)
}

// QueuedIn returns a copy of a worker's deque, head first.
func (s *Scheduler) QueuedIn(worker int) []int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]int(nil), s.deques[worker].items...)
}

// Counts returns how many tasks are queued, executed and cancelled.
func (s *Scheduler) Counts() (queued, executed, cancelled int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, rec := range s.tasks {
		switch rec.state {
		case Queued:
			queued++
		case Executed:
			executed++
		case Cancelled:
			cancelled++
		}
	}
	return queued, executed, cancelled
}

// CheckConservation verifies that every task is accounted for exactly
// once: it sits in exactly one deque, or it is executed, or it is
// cancelled. It also verifies deque/table agreement and that no
// executed task was ever cancelled.
func (s *Scheduler) CheckConservation() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	inDeque := make(map[int]int) // task id -> number of deque occurrences
	for w := range s.deques {
		seen := make(map[int]bool)
		for _, id := range s.deques[w].items {
			rec, ok := s.tasks[id]
			if !ok {
				return fmt.Errorf("deque %d holds unknown task %d", w, id)
			}
			if rec.state != Queued {
				return fmt.Errorf("deque %d holds task %d in state %s", w, id, rec.state)
			}
			if rec.owner != w {
				return fmt.Errorf("task %d recorded owner %d but sits in deque %d", id, rec.owner, w)
			}
			if seen[id] {
				return fmt.Errorf("task %d appears twice in deque %d", id, w)
			}
			seen[id] = true
			inDeque[id]++
		}
	}
	for id, rec := range s.tasks {
		switch rec.state {
		case Queued:
			if inDeque[id] != 1 {
				return fmt.Errorf("queued task %d found in %d deques", id, inDeque[id])
			}
		case Executed, Cancelled:
			if inDeque[id] != 0 {
				return fmt.Errorf("%s task %d still present in a deque", rec.state, id)
			}
		default:
			return fmt.Errorf("task %d in invalid state %d", id, rec.state)
		}
	}
	if len(s.execLog) != countState(s.tasks, Executed) {
		return fmt.Errorf("execution log length %d != executed count", len(s.execLog))
	}
	return nil
}

func countState(tasks map[int]*taskRec, st TaskState) int {
	n := 0
	for _, rec := range tasks {
		if rec.state == st {
			n++
		}
	}
	return n
}

// fingerprint encodes the full state for visited-set dedup during
// state-space exploration.
func (s *Scheduler) fingerprint() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var b strings.Builder
	for w := range s.deques {
		fmt.Fprintf(&b, "q%d:%v;", w, s.deques[w].items)
	}
	for id, rec := range s.tasks {
		fmt.Fprintf(&b, "t%d:%d/%d;", id, rec.state, rec.owner)
	}
	return b.String()
}

// Kind identifies an event type.
type Kind int

const (
	EvSubmit Kind = iota
	EvPopLocal
	EvSteal
	EvCancel
)

// Event is one discrete step in the simulation.
type Event struct {
	Kind   Kind
	Worker int // submitter / local popper / thief
	Victim int // steal target (EvSteal only)
	Task   int // task id (EvSubmit / EvCancel)
}

func (e Event) String() string {
	switch e.Kind {
	case EvSubmit:
		return fmt.Sprintf("submit(t%d->w%d)", e.Task, e.Worker)
	case EvPopLocal:
		return fmt.Sprintf("popLocal(w%d)", e.Worker)
	case EvSteal:
		return fmt.Sprintf("steal(w%d<-w%d)", e.Worker, e.Victim)
	case EvCancel:
		return fmt.Sprintf("cancel(t%d)", e.Task)
	}
	return "?"
}

// Result describes the outcome of applying one event.
type Result struct {
	Event   Event
	Took    int  // task id taken, valid only if Success
	Success bool // take succeeded / cancel took effect / submit accepted
}

// Step applies a single event, advancing the simulation by one step.
func (s *Scheduler) Step(ev Event) Result {
	r := Result{Event: ev, Took: -1}
	switch ev.Kind {
	case EvSubmit:
		r.Success = s.Submit(ev.Worker, ev.Task) == nil
	case EvPopLocal:
		id, ok := s.PopLocal(ev.Worker)
		r.Took, r.Success = id, ok
	case EvSteal:
		id, ok := s.Steal(ev.Worker, ev.Victim)
		r.Took, r.Success = id, ok
	case EvCancel:
		r.Success = s.Cancel(ev.Task)
	}
	return r
}

// StepAll applies a batch of events as one simulation step. Events are
// resolved sequentially under the scheduler lock, so when two take
// operations race for the same task exactly one of them succeeds.
func (s *Scheduler) StepAll(evs []Event) []Result {
	out := make([]Result, len(evs))
	for i, ev := range evs {
		out[i] = s.Step(ev)
	}
	return out
}
