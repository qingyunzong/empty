// Package sched implements a durable single-node scheduler for deferred
// tasks. Tasks are claimed in (Deadline, ID) order, every claim is
// persisted to a write-ahead log before it is returned, and
// acknowledgements are validated against generation and lease expiry.
package sched

import (
	"errors"
	"os"
	"sort"
	"sync"
)

var (
	ErrUnknownTask     = errors.New("sched: unknown task")
	ErrDuplicateTask   = errors.New("sched: duplicate task id")
	ErrEmptyID         = errors.New("sched: empty task id")
	ErrStaleGeneration = errors.New("sched: stale claim generation")
	ErrLeaseExpired    = errors.New("sched: lease expired")
	ErrAlreadyDone     = errors.New("sched: task already acknowledged")
	ErrNotLeased       = errors.New("sched: task is not leased")
)

// State is the lifecycle state of a task.
type State string

const (
	StatePending State = "pending" // never claimed, or lease expired
	StateLeased  State = "leased"  // claimed and lease still valid
	StateDone    State = "done"    // acknowledged
)

// Task is a unit of deferred work.
type Task struct {
	ID       string
	Deadline int64
	Payload  []byte
}

// ClaimToken is the evidence returned by a successful Claim. It is only
// returned after the claim record has been persisted to the log.
type ClaimToken struct {
	TaskID      string
	Deadline    int64
	Generation  int64
	LeaseExpiry int64
}

// Receipt is the evidence returned by a successful Ack.
type Receipt struct {
	TaskID     string
	Generation int64
	AckedAt    int64
}

// Status describes the current state of one task.
type Status struct {
	Task        Task
	State       State
	Generation  int64
	LeaseExpiry int64
}

type taskState struct {
	task        Task
	done        bool
	generation  int64
	leaseExpiry int64
}

func (ts *taskState) claimable(now int64) bool {
	if ts.done {
		return false
	}
	return ts.generation == 0 || now > ts.leaseExpiry
}

func (ts *taskState) state(now int64) State {
	switch {
	case ts.done:
		return StateDone
	case ts.generation != 0 && now <= ts.leaseExpiry:
		return StateLeased
	default:
		return StatePending
	}
}

func lessTask(a, b Task) bool {
	if a.Deadline != b.Deadline {
		return a.Deadline < b.Deadline
	}
	return a.ID < b.ID
}

// Scheduler hands out tasks in (Deadline, ID) order and persists every
// state transition before acknowledging it to the caller.
type Scheduler struct {
	mu       sync.Mutex
	f        *os.File
	w        syncWriter
	tasks    map[string]*taskState
	gen      int64
	leaseTTL int64
	now      func() int64

	// afterPersist, when set, runs after a record is durably written but
	// before the in-memory state is applied. Tests use it to inject
	// crashes at the exact persist/return boundary.
	afterPersist func(op string)
}

// Option configures a Scheduler.
type Option func(*Scheduler)

// WithClock sets the clock used for leases and receipts.
func WithClock(now func() int64) Option {
	return func(s *Scheduler) { s.now = now }
}

// WithLeaseTTL sets the lease duration in clock units.
func WithLeaseTTL(ttl int64) Option {
	return func(s *Scheduler) { s.leaseTTL = ttl }
}

// Add registers a task. The add record is persisted before Add returns.
func (s *Scheduler) Add(t Task) error {
	if t.ID == "" {
		return ErrEmptyID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.tasks[t.ID]; ok {
		return ErrDuplicateTask
	}
	if err := s.persist(record{Op: opAdd, ID: t.ID, Deadline: t.Deadline, Payload: t.Payload}); err != nil {
		return err
	}
	cp := t
	if t.Payload != nil {
		cp.Payload = append([]byte(nil), t.Payload...)
	}
	s.tasks[t.ID] = &taskState{task: cp}
	return nil
}

// Claim leases the claimable task with the smallest (Deadline, ID).
// The claim record is persisted before the token is returned. ok is
// false when no task is currently claimable.
func (s *Scheduler) Claim() (tok ClaimToken, ok bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	var best *taskState
	for _, ts := range s.tasks {
		if !ts.claimable(now) {
			continue
		}
		if best == nil || lessTask(ts.task, best.task) {
			best = ts
		}
	}
	if best == nil {
		return ClaimToken{}, false, nil
	}
	gen := s.gen + 1
	expiry := now + s.leaseTTL
	rec := record{Op: opClaim, ID: best.task.ID, Generation: gen, LeaseExpiry: expiry}
	if err := s.persist(rec); err != nil {
		return ClaimToken{}, false, err
	}
	s.gen = gen
	best.generation = gen
	best.leaseExpiry = expiry
	return ClaimToken{
		TaskID:      best.task.ID,
		Deadline:    best.task.Deadline,
		Generation:  gen,
		LeaseExpiry: expiry,
	}, true, nil
}

// Ack confirms completion of a claimed task. It rejects unknown tasks,
// stale generations, expired leases and duplicate acknowledgements. The
// ack record is persisted before the receipt is returned.
func (s *Scheduler) Ack(id string, generation int64) (Receipt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ts, ok := s.tasks[id]
	if !ok {
		return Receipt{}, ErrUnknownTask
	}
	if ts.done {
		return Receipt{}, ErrAlreadyDone
	}
	if ts.generation == 0 {
		return Receipt{}, ErrNotLeased
	}
	if generation != ts.generation {
		return Receipt{}, ErrStaleGeneration
	}
	now := s.now()
	if now > ts.leaseExpiry {
		return Receipt{}, ErrLeaseExpired
	}
	if err := s.persist(record{Op: opAck, ID: id, Generation: generation}); err != nil {
		return Receipt{}, err
	}
	ts.done = true
	return Receipt{TaskID: id, Generation: generation, AckedAt: now}, nil
}

// Status returns the current state of one task.
func (s *Scheduler) Status(id string) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ts, ok := s.tasks[id]
	if !ok {
		return Status{}, ErrUnknownTask
	}
	return s.statusOf(ts), nil
}

// Snapshot returns the state of every task, ordered by (Deadline, ID).
func (s *Scheduler) Snapshot() []Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Status, 0, len(s.tasks))
	for _, ts := range s.tasks {
		out = append(out, s.statusOf(ts))
	}
	sort.Slice(out, func(i, j int) bool { return lessTask(out[i].Task, out[j].Task) })
	return out
}

func (s *Scheduler) statusOf(ts *taskState) Status {
	return Status{
		Task:        ts.task,
		State:       ts.state(s.now()),
		Generation:  ts.generation,
		LeaseExpiry: ts.leaseExpiry,
	}
}

// Close closes the underlying log file.
func (s *Scheduler) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f != nil {
		return s.f.Close()
	}
	return nil
}
