package formal

import (
	"sort"
	"sync"
)

// Index is the destination index being built.
//
// Put and Delete must be idempotent: applying the same commit more than once
// must leave the index unchanged. Implementations do not need to be durable;
// the DDL executor is responsible for persisting a completed build.
type Index interface {
	Put(Key, Value)
	Delete(Key)
	Get(Key) (Value, bool)
	Len() int

	// Range visits every entry in ascending key order. It must stop and return
	// the visitor's error.
	Range(func(Key, Value) error) error

	// Entries returns a copy of the index contents.
	Entries() map[Key]Value
}

// MemIndex is an in-memory, concurrency-safe Index.
type MemIndex struct {
	mu      sync.RWMutex
	entries map[Key]Value
}

var _ Index = (*MemIndex)(nil)

// NewMemIndex returns an empty in-memory index.
func NewMemIndex() *MemIndex {
	return &MemIndex{entries: make(map[Key]Value)}
}

func (m *MemIndex) Put(k Key, v Value) {
	m.mu.Lock()
	m.entries[k] = v
	m.mu.Unlock()
}

func (m *MemIndex) Delete(k Key) {
	m.mu.Lock()
	delete(m.entries, k)
	m.mu.Unlock()
}

func (m *MemIndex) Get(k Key) (Value, bool) {
	m.mu.RLock()
	v, ok := m.entries[k]
	m.mu.RUnlock()
	return v, ok
}

func (m *MemIndex) Len() int {
	m.mu.RLock()
	n := len(m.entries)
	m.mu.RUnlock()
	return n
}

func (m *MemIndex) Range(visit func(Key, Value) error) error {
	m.mu.RLock()
	keys := make([]Key, 0, len(m.entries))
	for k := range m.entries {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	values := make([]Value, len(keys))
	for i, k := range keys {
		values[i] = m.entries[k]
	}
	m.mu.RUnlock()

	for i, k := range keys {
		if err := visit(k, values[i]); err != nil {
			return err
		}
	}
	return nil
}

func (m *MemIndex) Entries() map[Key]Value {
	m.mu.RLock()
	out := make(map[Key]Value, len(m.entries))
	for k, v := range m.entries {
		out[k] = v
	}
	m.mu.RUnlock()
	return out
}
