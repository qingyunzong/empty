package formal

import (
	"context"
	"fmt"
	"sync"
)

// MemStore is a deterministic object-store simulation.
//
// Writes are atomic and conditions are evaluated against the latest committed
// state. Reads are subject to a configurable visibility delay measured in
// logical operations: every Put commits at the next logical tick, every Get
// observes the state at the current tick and then advances the clock by one.
// Consequently, with delay d, the first d reads after a write may return
// ErrNotFound. Advancing the clock explicitly (Advance) or retrying reads
// eventually reveals the object.
//
// Putting a new version of a key keeps older versions visible to readers until
// the new version's delay elapses, matching a store whose replicas catch up
// independently.
type MemStore struct {
	mu          sync.Mutex
	clock       int64
	delay       int64
	nextVersion int64
	objects     map[string][]memVersion
}

type memVersion struct {
	data      []byte
	version   string
	committed int64
}

// NewMemStore creates a store whose reads lag writes by visibilityDelay
// logical operations. A non-positive delay makes reads immediately consistent.
func NewMemStore(visibilityDelay int64) *MemStore {
	if visibilityDelay < 0 {
		visibilityDelay = 0
	}
	return &MemStore{
		delay:   visibilityDelay,
		objects: make(map[string][]memVersion),
	}
}

// Advance moves the logical clock forward, simulating the passage of enough
// time for pending writes to become visible.
func (m *MemStore) Advance(operations int64) {
	if operations <= 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.clock += operations
}

// Clock reports the current logical tick.
func (m *MemStore) Clock() int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.clock
}

// Put atomically commits a new object version.
func (m *MemStore) Put(ctx context.Context, key string, data []byte, cond Condition) (Object, error) {
	if err := ctx.Err(); err != nil {
		return Object{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	versions := m.objects[key]
	if cond.IfNoneMatch && len(versions) > 0 {
		return Object{}, fmt.Errorf("%w: %s", ErrAlreadyExists, key)
	}
	if cond.IfMatch != "" {
		if len(versions) == 0 || versions[len(versions)-1].version != cond.IfMatch {
			return Object{}, fmt.Errorf("%w: %s", ErrPreconditionFailed, key)
		}
	}

	m.clock++
	m.nextVersion++
	version := fmt.Sprintf("v%d", m.nextVersion)
	m.objects[key] = append(versions, memVersion{
		data:      append([]byte(nil), data...),
		version:   version,
		committed: m.clock,
	})
	return Object{Data: append([]byte(nil), data...), Version: version}, nil
}

// Get returns the newest version visible at the current logical tick, then
// advances the clock by one operation.
func (m *MemStore) Get(ctx context.Context, key string) (Object, error) {
	if err := ctx.Err(); err != nil {
		return Object{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	view := m.clock
	m.clock++

	versions := m.objects[key]
	for i := len(versions) - 1; i >= 0; i-- {
		if versions[i].committed+m.delay <= view {
			return Object{Data: append([]byte(nil), versions[i].data...), Version: versions[i].version}, nil
		}
	}
	return Object{}, fmt.Errorf("%w: %s at tick %d", ErrNotFound, key, view)
}
