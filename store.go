package comm

import (
	"errors"
	"sort"
	"strings"
	"sync"
)

// ErrInjectedFault is returned by MemStore.Apply when a fault is armed.
var ErrInjectedFault = errors.New("injected store fault")

// Batch is a set of writes applied atomically by Store.Apply.
type Batch struct {
	Puts map[string]string
	Dels []string
}

// Store models durable storage. Apply must be atomic: either the whole
// batch becomes visible or nothing does.
type Store interface {
	Get(key string) (string, bool)
	Keys(prefix string) []string
	Apply(b Batch) error
}

// MemStore is an in-memory Store with fault injection for persisted writes.
type MemStore struct {
	mu   sync.Mutex
	data map[string]string
	// FailNextApplies arms write faults: the next N Apply calls fail
	// with ErrInjectedFault and persist nothing.
	FailNextApplies int
}

func NewMemStore() *MemStore {
	return &MemStore{data: map[string]string{}}
}

func (m *MemStore) Get(key string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.data[key]
	return v, ok
}

func (m *MemStore) Keys(prefix string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for k := range m.data {
		if strings.HasPrefix(k, prefix) {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func (m *MemStore) Apply(b Batch) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.FailNextApplies > 0 {
		m.FailNextApplies--
		return ErrInjectedFault
	}
	for k, v := range b.Puts {
		m.data[k] = v
	}
	for _, k := range b.Dels {
		delete(m.data, k)
	}
	return nil
}
