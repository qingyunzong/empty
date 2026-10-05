package plan

import (
	"errors"
	"fmt"
	"sync"
)

// ErrConflict marks a compare-and-swap rejected by an unexpected current
// value, typically an external modification.
var ErrConflict = errors.New("plan: conflicting external modification")

// MemStore is an in-memory Store with compare-and-swap semantics.
type MemStore struct {
	mu   sync.Mutex
	data map[string]Value
}

// NewMemStore returns a MemStore holding a copy of initial.
func NewMemStore(initial map[string]Value) *MemStore {
	m := &MemStore{data: make(map[string]Value, len(initial))}
	for k, v := range initial {
		if v.OK {
			m.data[k] = v
		}
	}
	return m
}

// Get returns the current state of key, or a zero Value if absent.
func (m *MemStore) Get(key string) Value {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.data[key]
}

// CAS implements Store.
func (m *MemStore) CAS(key string, expect, set Value) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if cur := m.data[key]; cur != expect {
		return fmt.Errorf("%w: key %q is %+v, expected %+v", ErrConflict, key, cur, expect)
	}
	if set.OK {
		m.data[key] = set
	} else {
		delete(m.data, key)
	}
	return nil
}

// Snapshot returns a copy of the current state.
func (m *MemStore) Snapshot() map[string]Value {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]Value, len(m.data))
	for k, v := range m.data {
		out[k] = v
	}
	return out
}
