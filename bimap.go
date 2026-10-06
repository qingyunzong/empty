// Package bimap implements a bijective map: keys and values are both unique,
// with atomic transactions, reverse lookup, and versioned snapshots.
package bimap

import (
	"errors"
	"fmt"
	"sync"
)

// ErrConflict is returned when a transaction would bind a value that is
// still held by a key outside the transaction.
var ErrConflict = errors.New("bimap: value already bound to another key")

// Snapshot is an immutable view of a BiMap at a specific version.
type Snapshot[K comparable, V comparable] struct {
	fwd     map[K]V
	rev     map[V]K
	version uint64
}

// Get returns the value bound to k.
func (s *Snapshot[K, V]) Get(k K) (V, bool) {
	v, ok := s.fwd[k]
	return v, ok
}

// GetKey returns the key bound to v (reverse lookup).
func (s *Snapshot[K, V]) GetKey(v V) (K, bool) {
	k, ok := s.rev[v]
	return k, ok
}

// Len returns the number of bindings in the snapshot.
func (s *Snapshot[K, V]) Len() int { return len(s.fwd) }

// Version returns the version this snapshot was taken at.
func (s *Snapshot[K, V]) Version() uint64 { return s.version }

// Range calls fn for every binding until fn returns false.
func (s *Snapshot[K, V]) Range(fn func(K, V) bool) {
	for k, v := range s.fwd {
		if !fn(k, v) {
			return
		}
	}
}

// BiMap is a bijective map: every key maps to exactly one value and every
// value is held by exactly one key. It is safe for concurrent use.
type BiMap[K comparable, V comparable] struct {
	mu      sync.RWMutex
	fwd     map[K]V
	rev     map[V]K
	version uint64
	snaps   map[uint64]*Snapshot[K, V]
}

// New returns an empty BiMap at version 0.
func New[K comparable, V comparable]() *BiMap[K, V] {
	m := &BiMap[K, V]{
		fwd:   make(map[K]V),
		rev:   make(map[V]K),
		snaps: make(map[uint64]*Snapshot[K, V]),
	}
	m.snaps[0] = &Snapshot[K, V]{fwd: make(map[K]V), rev: make(map[V]K)}
	return m
}

// Get returns the value bound to k.
func (m *BiMap[K, V]) Get(k K) (V, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	v, ok := m.fwd[k]
	return v, ok
}

// GetKey returns the key bound to v (reverse lookup).
func (m *BiMap[K, V]) GetKey(v V) (K, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	k, ok := m.rev[v]
	return k, ok
}

// Len returns the number of bindings.
func (m *BiMap[K, V]) Len() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.fwd)
}

// Version returns the current version, incremented by every successful commit.
func (m *BiMap[K, V]) Version() uint64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.version
}

// Snapshot returns the immutable snapshot for the given version.
func (m *BiMap[K, V]) Snapshot(version uint64) (*Snapshot[K, V], bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.snaps[version]
	return s, ok
}

// Put binds k to v in a single-operation transaction.
func (m *BiMap[K, V]) Put(k K, v V) error {
	tx := m.Begin()
	tx.Put(k, v)
	return tx.Commit()
}

// Remove deletes the binding for k in a single-operation transaction.
func (m *BiMap[K, V]) Remove(k K) error {
	tx := m.Begin()
	tx.Remove(k)
	return tx.Commit()
}

// Swap exchanges the values of two keys in one atomic transaction.
func (m *BiMap[K, V]) Swap(a, b K) error {
	m.mu.RLock()
	va, okA := m.fwd[a]
	vb, okB := m.fwd[b]
	m.mu.RUnlock()
	if !okA || !okB {
		return fmt.Errorf("bimap: swap requires both keys to be bound")
	}
	tx := m.Begin()
	tx.Put(a, vb)
	tx.Put(b, va)
	return tx.Commit()
}

// Begin starts a new transaction. Transactions are not goroutine-safe.
func (m *BiMap[K, V]) Begin() *Tx[K, V] {
	return &Tx[K, V]{
		m:       m,
		puts:    make(map[K]V),
		removes: make(map[K]struct{}),
	}
}

// Tx accumulates puts and removes, applied atomically by Commit.
type Tx[K comparable, V comparable] struct {
	m       *BiMap[K, V]
	puts    map[K]V
	removes map[K]struct{}
	done    bool
}

// Put stages a binding of k to v, replacing any staged binding for k.
func (t *Tx[K, V]) Put(k K, v V) {
	t.puts[k] = v
	delete(t.removes, k)
}

// Remove stages the deletion of the binding for k.
func (t *Tx[K, V]) Remove(k K) {
	t.removes[k] = struct{}{}
	delete(t.puts, k)
}

// Commit applies the transaction atomically. It first drops every old
// relation of the keys this transaction touches (freeing their values, so
// occupied values can be exchanged within the transaction), then checks that
// each staged value is still free. On conflict nothing is applied: the whole
// table and its version stay untouched.
func (t *Tx[K, V]) Commit() error {
	if t.done {
		return errors.New("bimap: transaction already committed")
	}
	t.done = true

	m := t.m
	m.mu.Lock()
	defer m.mu.Unlock()

	// Copy current state, then remove this transaction's old relations.
	fwd := make(map[K]V, len(m.fwd))
	for k, v := range m.fwd {
		fwd[k] = v
	}
	for k := range t.removes {
		delete(fwd, k)
	}
	for k := range t.puts {
		delete(fwd, k)
	}

	// Rebuild the reverse index of the surviving relations.
	rev := make(map[V]K, len(fwd))
	for k, v := range fwd {
		rev[v] = k
	}

	// Check staged puts against the surviving values (and each other).
	for k, v := range t.puts {
		if _, taken := rev[v]; taken {
			return fmt.Errorf("%w: %v", ErrConflict, v)
		}
		rev[v] = k
		fwd[k] = v
	}

	m.fwd = fwd
	m.rev = rev
	m.version++

	snapFwd := make(map[K]V, len(fwd))
	snapRev := make(map[V]K, len(rev))
	for k, v := range fwd {
		snapFwd[k] = v
	}
	for v, k := range rev {
		snapRev[v] = k
	}
	m.snaps[m.version] = &Snapshot[K, V]{fwd: snapFwd, rev: snapRev, version: m.version}
	return nil
}
