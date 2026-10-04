// Package offlineq implements an offline task queue with generation-based
// leases and a persisted, replayable event log.
//
// Time is logical: callers pass an int64 "now" to every operation. A lease
// is valid at time now iff now < Deadline, so a lease whose deadline equals
// now is already expired.
package offlineq

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
)

// Lease identifies one claim on a task. Generation increases by one on every
// successful (re-)claim of the same task, so a Lease from before a timeout
// re-claim can no longer be used to ack or extend.
type Lease struct {
	Task       string
	Holder     string
	Generation uint64
	Deadline   int64
}

type taskState struct {
	acked      bool
	claimed    bool // currently leased out (the lease may already be expired)
	generation uint64
	holder     string
	deadline   int64
}

// valid reports whether the task has a live lease at time now.
// now == deadline already counts as expired.
func (t *taskState) valid(now int64) bool {
	return t.claimed && !t.acked && now < t.deadline
}

var (
	ErrTaskExists  = errors.New("offlineq: task already exists")
	ErrUnknownTask = errors.New("offlineq: unknown task")
)

type event struct {
	Type       string `json:"type"`
	Task       string `json:"task"`
	Holder     string `json:"holder,omitempty"`
	Generation uint64 `json:"gen,omitempty"`
	Deadline   int64  `json:"deadline,omitempty"`
}

const (
	evAdd    = "add"
	evClaim  = "claim"
	evAck    = "ack"
	evExtend = "extend"
)

// Queue is a task queue backed by an append-only event log. It is safe for
// concurrent use.
type Queue struct {
	mu     sync.Mutex
	tasks  map[string]*taskState
	log    io.Writer // receives one JSON event per line; nil discards
	closer io.Closer
}

// New returns an in-memory Queue whose events are appended to log
// (one JSON object per line). If log is nil, events are discarded.
func New(log io.Writer) *Queue {
	return &Queue{tasks: make(map[string]*taskState), log: log}
}

// Open replays the event log at path (created if missing) and returns a
// Queue that appends new events to the same file.
func Open(path string) (*Queue, error) {
	q := New(nil)
	r, err := os.OpenFile(path, os.O_RDONLY|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(r)
	for {
		var ev event
		if err := dec.Decode(&ev); err == io.EOF {
			break
		} else if err != nil {
			r.Close()
			return nil, fmt.Errorf("offlineq: replay %s: %w", path, err)
		}
		q.apply(ev)
	}
	r.Close()

	w, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	q.log = w
	q.closer = w
	return q, nil
}

// Close closes the underlying log file, if any.
func (q *Queue) Close() error {
	if q.closer != nil {
		return q.closer.Close()
	}
	return nil
}

// Add registers a new task.
func (q *Queue) Add(id string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if _, ok := q.tasks[id]; ok {
		return ErrTaskExists
	}
	if err := q.append(event{Type: evAdd, Task: id}); err != nil {
		return err
	}
	q.tasks[id] = &taskState{}
	return nil
}

// Claim leases task id to holder until now+ttl. It fails if the task is
// unknown, already acked, or still held under a live lease. Each successful
// claim bumps the task's generation, invalidating every older lease.
func (q *Queue) Claim(id, holder string, now, ttl int64) (Lease, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	ts, ok := q.tasks[id]
	if !ok || ts.acked || ts.valid(now) {
		return Lease{}, false
	}
	lease := Lease{Task: id, Holder: holder, Generation: ts.generation + 1, Deadline: now + ttl}
	if err := q.append(event{Type: evClaim, Task: id, Holder: holder, Generation: lease.Generation, Deadline: lease.Deadline}); err != nil {
		return Lease{}, false
	}
	ts.claimed = true
	ts.generation = lease.Generation
	ts.holder = holder
	ts.deadline = lease.Deadline
	return lease, true
}

// Ack completes task id. It succeeds only for the current generation of a
// live (unexpired) lease; acks carrying an older generation from before a
// timeout re-claim are rejected.
func (q *Queue) Ack(id string, generation uint64, now int64) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	ts, ok := q.tasks[id]
	if !ok || generation != ts.generation || !ts.valid(now) {
		return false
	}
	if err := q.append(event{Type: evAck, Task: id, Generation: generation}); err != nil {
		return false
	}
	ts.acked = true
	return true
}

// Extend moves the deadline of a live lease. Only the current generation is
// accepted, and the new deadline must lie in the future.
func (q *Queue) Extend(id string, generation uint64, now, newDeadline int64) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	ts, ok := q.tasks[id]
	if !ok || generation != ts.generation || !ts.valid(now) || newDeadline <= now {
		return false
	}
	if err := q.append(event{Type: evExtend, Task: id, Generation: generation, Deadline: newDeadline}); err != nil {
		return false
	}
	ts.deadline = newDeadline
	return true
}

// CurrentHolder returns the live lease on task id at time now, if any.
// A task has at most one current holder at any moment.
func (q *Queue) CurrentHolder(id string, now int64) (Lease, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	ts, ok := q.tasks[id]
	if !ok || !ts.valid(now) {
		return Lease{}, false
	}
	return Lease{Task: id, Holder: ts.holder, Generation: ts.generation, Deadline: ts.deadline}, true
}

func (q *Queue) append(ev event) error {
	if q.log == nil {
		return nil
	}
	return json.NewEncoder(q.log).Encode(ev)
}

// apply mutates state from a replayed event without logging.
func (q *Queue) apply(ev event) {
	ts := q.tasks[ev.Task]
	switch ev.Type {
	case evAdd:
		q.tasks[ev.Task] = &taskState{}
	case evClaim:
		ts.claimed = true
		ts.generation = ev.Generation
		ts.holder = ev.Holder
		ts.deadline = ev.Deadline
	case evAck:
		ts.acked = true
	case evExtend:
		ts.deadline = ev.Deadline
	}
}
