// Package scheduler is a persistent lease-based task scheduler.
//
// Tasks are claimed in (deadline, ID) order. A claim is durable before it is
// returned: the claim record is appended to the log and fsynced first, so a
// crash either exposes the full claim after recovery or none of it. Claims
// carry a generation and a lease expiry; an unacknowledged task whose lease
// lapses (e.g. after a restart) becomes claimable again with a new
// generation, and ACKs for stale generations or expired leases are rejected.
package scheduler

import (
	"errors"
	"sort"
	"sync"
)

// State is the lifecycle state of a task.
type State int

const (
	Pending State = iota
	Claimed
	Done
)

func (s State) String() string {
	switch s {
	case Pending:
		return "pending"
	case Claimed:
		return "claimed"
	case Done:
		return "done"
	}
	return "unknown"
}

// Task is a scheduled task and its current claim metadata.
type Task struct {
	ID          string
	Deadline    int64
	Payload     string
	State       State
	Generation  int
	ClaimExpiry int64
}

// Claim is the evidence returned to a claimant: a snapshot of the task plus
// the generation and lease expiry that a matching Ack must present.
type Claim struct {
	Task       Task
	Generation int
	Expiry     int64
}

var (
	ErrTaskNotFound    = errors.New("scheduler: task not found")
	ErrTaskExists      = errors.New("scheduler: task already exists")
	ErrNotClaimed      = errors.New("scheduler: task is not claimed")
	ErrAlreadyDone     = errors.New("scheduler: task already done")
	ErrStaleGeneration = errors.New("scheduler: stale generation")
	ErrLeaseExpired    = errors.New("scheduler: claim lease expired")
)

// Persistence stages reported to the crash hook, in order.
const (
	StageBeforeWrite = "before-write"
	StageBeforeSync  = "before-sync"
	StageAfterSync   = "after-sync"
)

// Scheduler hands out tasks in (deadline, ID) order and persists every state
// transition to an append-only log before reporting success.
type Scheduler struct {
	mu    sync.Mutex
	tasks map[string]*Task
	st    *store
	lease int64
	now   func() int64

	// crashHook, when set, is invoked at each persistence stage. It exists
	// for crash-injection tests and must be nil in production.
	crashHook func(stage string)
}

// Open opens (or creates) the scheduler log at path and replays it to
// rebuild in-memory state. lease is the claim lease duration in the same
// units as the clock returned by now.
func Open(path string, lease int64, now func() int64) (*Scheduler, error) {
	st, err := openStore(path)
	if err != nil {
		return nil, err
	}
	s := &Scheduler{
		tasks: make(map[string]*Task),
		st:    st,
		lease: lease,
		now:   now,
	}
	err = st.replay(func(rec record) error {
		switch rec.Op {
		case opAdd:
			s.tasks[rec.ID] = &Task{ID: rec.ID, Deadline: rec.Deadline, Payload: rec.Payload}
		case opClaim:
			if t, ok := s.tasks[rec.ID]; ok {
				t.State = Claimed
				t.Generation = rec.Gen
				t.ClaimExpiry = rec.Expiry
			}
		case opAck:
			if t, ok := s.tasks[rec.ID]; ok {
				t.State = Done
			}
		}
		return nil
	})
	if err != nil {
		st.close()
		return nil, err
	}
	return s, nil
}

// Close releases the underlying log. Unsynced records, if any, are dropped.
func (s *Scheduler) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.st.close()
}

// Add schedules a new pending task. The add is durable before Add returns.
func (s *Scheduler) Add(id string, deadline int64, payload string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.tasks[id]; ok {
		return ErrTaskExists
	}
	if err := s.persist(record{Op: opAdd, ID: id, Deadline: deadline, Payload: payload}); err != nil {
		return err
	}
	s.tasks[id] = &Task{ID: id, Deadline: deadline, Payload: payload}
	return nil
}

// Claim returns the claimable task with the smallest (deadline, ID). A task
// is claimable when pending, or when claimed but its lease has expired (which
// is how unacknowledged tasks become claimable again after a restart, with a
// new generation). The claim record is durable before Claim returns.
func (s *Scheduler) Claim() (Claim, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	var next *Task
	for _, t := range s.tasks {
		if !s.claimable(t, now) {
			continue
		}
		if next == nil || less(t, next) {
			next = t
		}
	}
	if next == nil {
		return Claim{}, false, nil
	}
	gen := next.Generation + 1
	expiry := now + s.lease
	if err := s.persist(record{Op: opClaim, ID: next.ID, Gen: gen, Expiry: expiry}); err != nil {
		return Claim{}, false, err
	}
	next.State = Claimed
	next.Generation = gen
	next.ClaimExpiry = expiry
	return Claim{Task: *next, Generation: gen, Expiry: expiry}, true, nil
}

// Ack completes a claimed task. It rejects unknown tasks, tasks not currently
// claimed, stale generations, and ACKs arriving after the lease has expired.
// The ack record is durable before Ack returns nil.
func (s *Scheduler) Ack(id string, gen int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tasks[id]
	if !ok {
		return ErrTaskNotFound
	}
	switch t.State {
	case Done:
		return ErrAlreadyDone
	case Pending:
		return ErrNotClaimed
	}
	if gen != t.Generation {
		return ErrStaleGeneration
	}
	if s.now() > t.ClaimExpiry {
		return ErrLeaseExpired
	}
	if err := s.persist(record{Op: opAck, ID: id, Gen: gen}); err != nil {
		return err
	}
	t.State = Done
	return nil
}

// Snapshot returns all tasks sorted by (deadline, ID).
func (s *Scheduler) Snapshot() []Task {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Task, 0, len(s.tasks))
	for _, t := range s.tasks {
		out = append(out, *t)
	}
	sort.Slice(out, func(i, j int) bool { return less(&out[i], &out[j]) })
	return out
}

func (s *Scheduler) claimable(t *Task, now int64) bool {
	return t.State == Pending || (t.State == Claimed && now > t.ClaimExpiry)
}

// less orders tasks by integer deadline, then by ID.
func less(a, b *Task) bool {
	if a.Deadline != b.Deadline {
		return a.Deadline < b.Deadline
	}
	return a.ID < b.ID
}

// persist appends rec to the log and fsyncs it before returning.
func (s *Scheduler) persist(rec record) error {
	s.hook(StageBeforeWrite)
	if err := s.st.append(rec); err != nil {
		return err
	}
	s.hook(StageBeforeSync)
	if err := s.st.sync(); err != nil {
		return err
	}
	s.hook(StageAfterSync)
	return nil
}

func (s *Scheduler) hook(stage string) {
	if s.crashHook != nil {
		s.crashHook(stage)
	}
}
