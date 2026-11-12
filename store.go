package dataeng

import (
	"context"
	"sync"
)

// MemoryStore is an in-memory CheckpointStore suitable for tests and for
// embedding inside application-specific Transaction implementations. Its
// zero value is not ready; use NewMemoryStore.
type MemoryStore struct {
	mu         sync.RWMutex
	checkpoint *Checkpoint
}

// NewMemoryStore creates an empty MemoryStore.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{}
}

// Load returns the most recently saved checkpoint, or nil when none exists.
func (s *MemoryStore) Load(_ context.Context) (*Checkpoint, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.checkpoint.Clone(), nil
}

// Save stores a deep copy of checkpoint.
func (s *MemoryStore) Save(_ context.Context, checkpoint *Checkpoint) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.checkpoint = checkpoint.Clone()
	return nil
}

// Current returns a deep copy of the stored checkpoint, or nil.
func (s *MemoryStore) Current() *Checkpoint {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.checkpoint.Clone()
}

// MemoryTransaction is a Transaction that appends delivered records and saves
// the checkpoint in one in-memory step. Failures can be scripted through
// RejectNext and FailNextLoad to exercise recovery paths.
type MemoryTransaction struct {
	*MemoryStore

	mu sync.Mutex

	// RejectNext makes the next Confirm return an explicit ErrRejected
	// without persisting anything.
	RejectNext bool
	// UnknownNext makes the next Confirm return a non-rejected error without
	// persisting anything, simulating an ambiguous outcome.
	UnknownNext bool
	// FailLoad makes subsequent Load calls return failErr.
	FailLoad bool
	failErr  error

	delivered [][]Record
	confirmed []*Checkpoint
	attempts  [][]Record
}

// NewMemoryTransaction creates a transaction backed by a fresh MemoryStore.
func NewMemoryTransaction() *MemoryTransaction {
	return &MemoryTransaction{MemoryStore: NewMemoryStore()}
}

// SetLoadFailure programs Load to return err until cleared.
func (t *MemoryTransaction) SetLoadFailure(err error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.FailLoad = true
	t.failErr = err
}

// ClearLoadFailure restores successful Load calls.
func (t *MemoryTransaction) ClearLoadFailure() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.FailLoad = false
	t.failErr = nil
}

// Load overrides MemoryStore.Load to support scripted load failures.
func (t *MemoryTransaction) Load(ctx context.Context) (*Checkpoint, error) {
	t.mu.Lock()
	failLoad := t.FailLoad
	err := t.failErr
	t.mu.Unlock()
	if failLoad {
		return nil, err
	}
	return t.MemoryStore.Load(ctx)
}

// Confirm applies or rejects the batch and checkpoint together.
func (t *MemoryTransaction) Confirm(ctx context.Context, records []Record, checkpoint *Checkpoint) error {
	t.mu.Lock()
	reject := t.RejectNext
	unknown := t.UnknownNext
	t.mu.Unlock()

	t.mu.Lock()
	t.attempts = append(t.attempts, cloneRecords(records))
	t.mu.Unlock()

	if reject {
		t.mu.Lock()
		t.RejectNext = false
		t.mu.Unlock()
		return ErrRejected
	}
	if unknown {
		t.mu.Lock()
		t.UnknownNext = false
		t.mu.Unlock()
		return ErrAmbiguous
	}
	if err := t.Save(ctx, checkpoint); err != nil {
		return err
	}

	t.mu.Lock()
	t.delivered = append(t.delivered, cloneRecords(records))
	t.confirmed = append(t.confirmed, checkpoint.Clone())
	t.mu.Unlock()
	return nil
}

// Delivered returns deep copies of every successfully confirmed batch.
func (t *MemoryTransaction) Delivered() [][]Record {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([][]Record, len(t.delivered))
	for i, batch := range t.delivered {
		out[i] = cloneRecords(batch)
	}
	return out
}

// Confirmed returns deep copies of every successfully confirmed checkpoint.
func (t *MemoryTransaction) Confirmed() []*Checkpoint {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]*Checkpoint, len(t.confirmed))
	for i, checkpoint := range t.confirmed {
		out[i] = checkpoint.Clone()
	}
	return out
}

// Attempts returns deep copies of every batch passed to Confirm, including
// batches whose confirmation was rejected or had an unknown outcome.
func (t *MemoryTransaction) Attempts() [][]Record {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([][]Record, len(t.attempts))
	for i, batch := range t.attempts {
		out[i] = cloneRecords(batch)
	}
	return out
}
