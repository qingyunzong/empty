// Package planexec executes plans of steps where every step carries a
// precondition, a post-image check and an inverse action. Batch failures
// roll back applied steps in reverse order; rollback failures preserve the
// unrecovered tail for later recovery, and unknown external modifications
// are never force-overwritten.
package planexec

import "sync"

// Store is the minimal key-value surface steps operate on.
type Store interface {
	Get(key string) (string, bool)
	Set(key, value string) error
	Delete(key string) error
}

// MemStore is an in-memory Store.
type MemStore struct {
	mu   sync.Mutex
	data map[string]string
}

func NewMemStore() *MemStore {
	return &MemStore{data: make(map[string]string)}
}

func (m *MemStore) Get(key string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.data[key]
	return v, ok
}

func (m *MemStore) Set(key, value string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[key] = value
	return nil
}

func (m *MemStore) Delete(key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, key)
	return nil
}

// Snapshot returns a copy of the current contents.
func (m *MemStore) Snapshot() map[string]string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]string, len(m.data))
	for k, v := range m.data {
		out[k] = v
	}
	return out
}
