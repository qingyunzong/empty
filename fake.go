package plan

import (
	"errors"
	"sync"
)

// ErrInjected is returned by a FakeStore operation hit by an injected fault.
var ErrInjected = errors.New("plan: injected fault")

// FakeStore wraps a MemStore with deterministic fault injection so tests
// can exhaustively place failures at any mutation point of a plan run.
type FakeStore struct {
	inner *MemStore

	mu       sync.Mutex
	casCalls int
	failAt   map[int]bool
}

// NewFakeStore returns a FakeStore holding a copy of initial.
func NewFakeStore(initial map[string]Value) *FakeStore {
	return &FakeStore{inner: NewMemStore(initial), failAt: make(map[int]bool)}
}

// FailAt makes the n-th CAS call (0-based) fail once with ErrInjected.
// It may be called several times to combine faults.
func (f *FakeStore) FailAt(n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failAt[n] = true
}

// Get implements Store; reads never fail.
func (f *FakeStore) Get(key string) Value { return f.inner.Get(key) }

// CAS implements Store, honouring injected faults before delegating.
func (f *FakeStore) CAS(key string, expect, set Value) error {
	f.mu.Lock()
	idx := f.casCalls
	f.casCalls++
	fail := f.failAt[idx]
	delete(f.failAt, idx)
	f.mu.Unlock()
	if fail {
		return ErrInjected
	}
	return f.inner.CAS(key, expect, set)
}

// Snapshot returns a copy of the current state.
func (f *FakeStore) Snapshot() map[string]Value { return f.inner.Snapshot() }
