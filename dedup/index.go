package dedup

import (
	"context"
	"sync"
	"sync/atomic"
)

// Index is the persistent, authoritative record of every accepted event key.
// Bloom layers only narrow down candidates: a Bloom hit is treated as a
// suspicion that must be confirmed against the index, and events whose event
// time has aged out of all retained windows are checked against the index
// directly. Implementations must be durable; Put must not return success
// before the key survives a restart.
type Index interface {
	Has(ctx context.Context, key string) (bool, error)
	Put(ctx context.Context, key string) error
}

// CheckpointableIndex may be implemented by an Index that can flush all
// pending writes to durable storage. Deduper.Snapshot invokes it before
// encoding its own state so that the snapshot and the index form a
// consistent cut.
type CheckpointableIndex interface {
	Index
	Checkpoint(ctx context.Context) error
}

// MemIndex is an in-memory Index intended for tests and demos. It is not
// durable and must not be used in production.
type MemIndex struct {
	mu   sync.Mutex
	keys map[string]struct{}

	hasCalls    atomic.Int64
	putCalls    atomic.Int64
	checkpoints atomic.Int64
}

func NewMemIndex() *MemIndex {
	return &MemIndex{keys: make(map[string]struct{})}
}

func (m *MemIndex) Has(_ context.Context, key string) (bool, error) {
	m.hasCalls.Add(1)
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.keys[key]
	return ok, nil
}

func (m *MemIndex) Put(_ context.Context, key string) error {
	m.putCalls.Add(1)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.keys[key] = struct{}{}
	return nil
}

// Checkpoint implements CheckpointableIndex.
func (m *MemIndex) Checkpoint(context.Context) error {
	m.checkpoints.Add(1)
	return nil
}

// HasCalls reports how many times Has was invoked (observability for tests).
func (m *MemIndex) HasCalls() int64 { return m.hasCalls.Load() }

// PutCalls reports how many times Put was invoked.
func (m *MemIndex) PutCalls() int64 { return m.putCalls.Load() }

// Checkpoints reports how many times Checkpoint was invoked.
func (m *MemIndex) Checkpoints() int64 { return m.checkpoints.Load() }

// Len reports the number of stored keys.
func (m *MemIndex) Len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.keys)
}
