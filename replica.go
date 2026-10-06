package readwait

import (
	"context"
	"errors"
	"sync"
	"time"
)

// ErrKeyNotFound is returned when a key has no applied value.
var ErrKeyNotFound = errors.New("readwait: key not found")

// Replica is a minimal follower-side store. Writes are committed first and
// applied later; a read registers the commit index observed at read time and
// returns only after the replica has applied up to it.
type Replica struct {
	tracker *Tracker

	mu          sync.RWMutex
	commitIndex uint64
	applied     map[string]string
	pending     map[uint64]entry
}

type entry struct {
	key   string
	value string
}

// NewReplica returns a Replica whose wait tracker is driven by clock;
// nil selects RealClock.
func NewReplica(clock Clock) *Replica {
	return &Replica{
		tracker: NewTracker(clock),
		applied: make(map[string]string),
		pending: make(map[uint64]entry),
	}
}

// Tracker exposes the replica's wait tracker.
func (r *Replica) Tracker() *Tracker { return r.tracker }

// CommitIndex returns the current commit index.
func (r *Replica) CommitIndex() uint64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.commitIndex
}

// Commit appends a write at the next index. The write is committed but not
// yet applied, so it is invisible to reads until ApplyTo covers its index.
func (r *Replica) Commit(key, value string) uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.commitIndex++
	r.pending[r.commitIndex] = entry{key: key, value: value}
	return r.commitIndex
}

// ApplyTo applies every committed entry up to index and notifies waiters.
// The applied index never regresses.
func (r *Replica) ApplyTo(index uint64) {
	r.mu.Lock()
	for i, e := range r.pending {
		if i <= index {
			r.applied[e.key] = e.value
			delete(r.pending, i)
		}
	}
	r.mu.Unlock()
	r.tracker.NotifyApplied(index)
}

// Read registers the current commit index as the wait target, then blocks
// until the replica has applied up to it, the timeout elapses, or ctx is
// canceled. It never returns a stale value: a timeout yields
// *NotAppliedError and no value.
func (r *Replica) Read(ctx context.Context, key string, timeout time.Duration) (string, error) {
	target := r.CommitIndex()
	if err := r.tracker.WaitApplied(ctx, target, timeout); err != nil {
		return "", err
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	value, ok := r.applied[key]
	if !ok {
		return "", ErrKeyNotFound
	}
	return value, nil
}

// InstallSnapshot installs a snapshot taken at lastIncludedIndex. The
// applied index never regresses: a snapshot at or behind the current applied
// index is rejected and its data is not installed.
func (r *Replica) InstallSnapshot(lastIncludedIndex uint64, data map[string]string) bool {
	if !r.tracker.InstallSnapshot(lastIncludedIndex) {
		return false
	}
	r.mu.Lock()
	installed := make(map[string]string, len(data))
	for k, v := range data {
		installed[k] = v
	}
	r.applied = installed
	for i := range r.pending {
		if i <= lastIncludedIndex {
			delete(r.pending, i)
		}
	}
	r.mu.Unlock()
	return true
}
