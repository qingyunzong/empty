// Package schedsim implements an event-stepped work-stealing scheduler
// simulator. Each worker owns a deque: the local worker takes from the
// tail, thieves steal from the head. Cancellation only takes effect on
// tasks that have not executed yet. All operations are driven by an
// explicit, totally ordered event stream (logical steps, no real time),
// so every take is an atomic check-and-remove: when two takes compete
// for the same task, exactly one of them succeeds.
package schedsim

import "fmt"

// TaskState is the lifecycle state of a task.
type TaskState int

const (
	StateQueued TaskState = iota
	StateExecuted
	StateCancelled
)

// Task is a unit of work.
type Task struct {
	ID    int
	State TaskState
}

// Deque is a double-ended queue of tasks. Index 0 is the head.
type Deque struct {
	items []*Task
}

// Len returns the number of tasks in the deque.
func (d *Deque) Len() int { return len(d.items) }

// PushTail appends a task at the tail.
func (d *Deque) PushTail(t *Task) { d.items = append(d.items, t) }

// PopTail removes and returns the tail task (local take).
func (d *Deque) PopTail() (*Task, bool) {
	n := len(d.items)
	if n == 0 {
		return nil, false
	}
	t := d.items[n-1]
	d.items[n-1] = nil
	d.items = d.items[:n-1]
	return t, true
}

// PopHead removes and returns the head task (steal).
func (d *Deque) PopHead() (*Task, bool) {
	if len(d.items) == 0 {
		return nil, false
	}
	t := d.items[0]
	d.items[0] = nil
	d.items = d.items[1:]
	return t, true
}

// Scheduler is a set of per-worker deques plus the task registry.
type Scheduler struct {
	queues   []*Deque
	tasks    map[int]*Task
	order    []int // task IDs in submission order
	nextID   int
	executed int
}

// NewScheduler creates a scheduler with numQueues worker deques.
func NewScheduler(numQueues int) *Scheduler {
	if numQueues <= 0 {
		panic("schedsim: need at least one queue")
	}
	return &Scheduler{
		queues: make([]*Deque, numQueues),
		tasks:  make(map[int]*Task),
	}
}

func (s *Scheduler) queue(q int) *Deque {
	if s.queues[q] == nil {
		s.queues[q] = &Deque{}
	}
	return s.queues[q]
}

// NumQueues returns the number of worker deques.
func (s *Scheduler) NumQueues() int { return len(s.queues) }

// QueueLen returns the number of queued tasks on queue q.
func (s *Scheduler) QueueLen(q int) int { return s.queue(q).Len() }

// Submitted returns the total number of tasks ever submitted.
func (s *Scheduler) Submitted() int { return len(s.order) }

// Executed returns the number of tasks executed so far.
func (s *Scheduler) Executed() int { return s.executed }

// Queued returns the number of tasks currently sitting in deques.
func (s *Scheduler) Queued() int {
	n := 0
	for _, q := range s.queues {
		if q != nil {
			n += q.Len()
		}
	}
	return n
}

// Cancelled returns the number of tasks cancelled before execution.
func (s *Scheduler) Cancelled() int { return s.Submitted() - s.Executed() - s.Queued() }

// Submit creates a task and pushes it onto the tail of queue q.
// It returns the new task ID.
func (s *Scheduler) Submit(q int) int {
	t := &Task{ID: s.nextID, State: StateQueued}
	s.nextID++
	s.tasks[t.ID] = t
	s.order = append(s.order, t.ID)
	s.queue(q).PushTail(t)
	return t.ID
}

// resolve executes a popped task unless it was already cancelled.
func (s *Scheduler) resolve(t *Task) {
	if t.State == StateQueued {
		t.State = StateExecuted
		s.executed++
	}
}

// LocalTake pops the tail of queue q and resolves the task.
// It reports whether a task was actually taken.
func (s *Scheduler) LocalTake(q int) (int, bool) {
	t, ok := s.queue(q).PopTail()
	if !ok {
		return -1, false
	}
	s.resolve(t)
	return t.ID, true
}

// Steal pops the head of queue from on behalf of worker to and resolves
// the task. It reports whether a task was actually taken.
func (s *Scheduler) Steal(from, to int) (int, bool) {
	if from == to {
		panic("schedsim: steal source and destination must differ")
	}
	t, ok := s.queue(from).PopHead()
	if !ok {
		return -1, false
	}
	s.resolve(t)
	return t.ID, true
}

// Cancel cancels task id if it has not executed yet, removing it from
// whichever deque holds it. It reports whether the cancellation took
// effect; cancelling an already executed task is a no-op.
func (s *Scheduler) Cancel(id int) bool {
	t, ok := s.tasks[id]
	if !ok || t.State != StateQueued {
		return false
	}
	t.State = StateCancelled
	for _, q := range s.queues {
		if q == nil {
			continue
		}
		for i, it := range q.items {
			if it.ID == id {
				q.items = append(q.items[:i], q.items[i+1:]...)
				return true
			}
		}
	}
	return true
}

// EventKind identifies the type of a simulation event.
type EventKind int

const (
	EvSubmit EventKind = iota
	EvLocalTake
	EvSteal
	EvCancel
)

// Event is one logical step in the simulation.
type Event struct {
	Kind   EventKind
	Queue  int // EvSubmit, EvLocalTake
	From   int // EvSteal: source queue
	To     int // EvSteal: destination worker
	TaskID int // EvCancel
}

// Apply advances the simulation by one event.
func (s *Scheduler) Apply(ev Event) {
	switch ev.Kind {
	case EvSubmit:
		s.Submit(ev.Queue)
	case EvLocalTake:
		s.LocalTake(ev.Queue)
	case EvSteal:
		s.Steal(ev.From, ev.To)
	case EvCancel:
		s.Cancel(ev.TaskID)
	}
}

// Run replays a whole history of events in order.
func (s *Scheduler) Run(history []Event) {
	for _, ev := range history {
		s.Apply(ev)
	}
}

// CheckInvariants verifies queue conservation and execution accounting:
// every task is in exactly one place (one deque, executed, or cancelled),
// no deque holds a non-queued task, no task appears twice, and the
// executed counter matches the registry.
func (s *Scheduler) CheckInvariants() error {
	inQueue := map[int]int{}
	for qi, q := range s.queues {
		if q == nil {
			continue
		}
		for _, t := range q.items {
			inQueue[t.ID]++
			if t.State != StateQueued {
				return fmt.Errorf("queue %d holds task %d in state %d", qi, t.ID, t.State)
			}
		}
	}
	for id, c := range inQueue {
		if c != 1 {
			return fmt.Errorf("task %d appears %d times across queues", id, c)
		}
	}
	executed := 0
	for _, id := range s.order {
		t := s.tasks[id]
		switch t.State {
		case StateQueued:
			if inQueue[id] != 1 {
				return fmt.Errorf("queued task %d missing from deques", id)
			}
		case StateExecuted:
			executed++
			if inQueue[id] != 0 {
				return fmt.Errorf("executed task %d still in a deque", id)
			}
		case StateCancelled:
			if inQueue[id] != 0 {
				return fmt.Errorf("cancelled task %d still in a deque", id)
			}
		}
	}
	if executed != s.executed {
		return fmt.Errorf("executed counter %d != registry count %d", s.executed, executed)
	}
	if s.Executed()+s.Cancelled()+s.Queued() != s.Submitted() {
		return fmt.Errorf("conservation violated: %d executed + %d cancelled + %d queued != %d submitted",
			s.Executed(), s.Cancelled(), s.Queued(), s.Submitted())
	}
	return nil
}

// Clone returns a deep copy of the scheduler.
func (s *Scheduler) Clone() *Scheduler {
	ns := &Scheduler{
		queues:   make([]*Deque, len(s.queues)),
		tasks:    make(map[int]*Task, len(s.tasks)),
		order:    append([]int(nil), s.order...),
		nextID:   s.nextID,
		executed: s.executed,
	}
	for id, t := range s.tasks {
		ns.tasks[id] = &Task{ID: t.ID, State: t.State}
	}
	for i, q := range s.queues {
		if q == nil {
			continue
		}
		nq := &Deque{items: make([]*Task, len(q.items))}
		for j, t := range q.items {
			nq.items[j] = ns.tasks[t.ID]
		}
		ns.queues[i] = nq
	}
	return ns
}

// Key returns a canonical string encoding of the full state, suitable
// for deduplicating states during history enumeration.
func (s *Scheduler) Key() string {
	b := make([]byte, 0, 64)
	for _, q := range s.queues {
		if q != nil {
			for _, t := range q.items {
				b = append(b, byte('a'+t.ID))
			}
		}
		b = append(b, '|')
	}
	b = append(b, '#')
	for _, id := range s.order {
		b = append(b, byte('0'+s.tasks[id].State))
	}
	return string(b)
}
