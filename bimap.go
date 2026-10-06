// Package bimap provides a bijective (one-to-one) map with transactional
// batch updates, reverse lookup, and immutable version snapshots.
//
// Keys and values are both unique: every key maps to exactly one value and
// every value is mapped from exactly one key. A transaction may reassign
// values that are currently occupied (including multi-key cycles such as
// A->B->C) because the transaction's own old relations are removed before
// conflicts are checked. A failed commit leaves the whole table untouched.
package bimap

import (
	"fmt"
	"sort"
	"sync"
)

// ConflictError describes why a commit was rejected. The table is left
// completely unchanged when a Commit returns a ConflictError.
type ConflictError struct {
	// ValueConflicts lists values requested by the transaction that are
	// still occupied by keys outside the transaction.
	ValueConflicts []string
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("bimap: commit conflict, values occupied: %v", e.ValueConflicts)
}

// BiMap is a thread-safe bijective map with versioned snapshots.
type BiMap[K comparable, V comparable] struct {
	mu        sync.RWMutex
	forward   map[K]V
	reverse   map[V]K
	snapshots []Snapshot[K, V] // snapshots[i] is the state at version i
}

// New returns an empty BiMap at version 0.
func New[K comparable, V comparable]() *BiMap[K, V] {
	m := &BiMap[K, V]{
		forward: make(map[K]V),
		reverse: make(map[V]K),
	}
	m.snapshots = append(m.snapshots, takeSnapshot(0, m.forward))
	return m
}

// Get returns the value mapped to key k.
func (m *BiMap[K, V]) Get(k K) (V, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	v, ok := m.forward[k]
	return v, ok
}

// GetByValue returns the key mapped to value v (reverse lookup).
func (m *BiMap[K, V]) GetByValue(v V) (K, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	k, ok := m.reverse[v]
	return k, ok
}

// Len returns the number of key-value pairs.
func (m *BiMap[K, V]) Len() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.forward)
}

// Version returns the current version. Every successful commit increments it.
func (m *BiMap[K, V]) Version() uint64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return uint64(len(m.snapshots)) - 1
}

// Snapshot returns the immutable state at the given version.
func (m *BiMap[K, V]) Snapshot(version uint64) (Snapshot[K, V], bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if version >= uint64(len(m.snapshots)) {
		return Snapshot[K, V]{}, false
	}
	return m.snapshots[version], true
}

// Begin starts a new transaction. The transaction itself is not
// thread-safe; use it from a single goroutine.
func (m *BiMap[K, V]) Begin() *Tx[K, V] {
	return &Tx[K, V]{
		sets: make(map[K]V),
		dels: make(map[K]struct{}),
	}
}

// Tx accumulates a batch of changes to be applied atomically by Commit.
type Tx[K comparable, V comparable] struct {
	sets map[K]V
	dels map[K]struct{}
}

// Set maps k to v within the transaction. It may reference keys and values
// that are currently occupied, as long as the final batch is conflict-free
// once the transaction's own old relations are removed.
func (t *Tx[K, V]) Set(k K, v V) {
	t.sets[k] = v
	delete(t.dels, k)
}

// Delete removes k (and its value) within the transaction.
func (t *Tx[K, V]) Delete(k K) {
	delete(t.sets, k)
	t.dels[k] = struct{}{}
}

// Commit applies the transaction atomically. It first removes the
// transaction's own old relations, then checks the remaining table for
// value conflicts. On any conflict the whole table is left unchanged and a
// *ConflictError is returned. On success the version is incremented and a
// new snapshot becomes available.
func (m *BiMap[K, V]) Commit(t *Tx[K, V]) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Work on clones so a failure keeps the whole table untouched.
	forward := make(map[K]V, len(m.forward))
	for k, v := range m.forward {
		forward[k] = v
	}
	reverse := make(map[V]K, len(m.reverse))
	for v, k := range m.reverse {
		reverse[v] = k
	}

	// Step 1: remove this transaction's old relations first.
	for k := range t.sets {
		if old, ok := forward[k]; ok {
			delete(reverse, old)
			delete(forward, k)
		}
	}
	for k := range t.dels {
		if old, ok := forward[k]; ok {
			delete(reverse, old)
			delete(forward, k)
		}
	}

	// Step 2: check what remains for conflicts.
	var conflicts []string
	seen := make(map[V]K, len(t.sets))
	for k, v := range t.sets {
		if other, dup := seen[v]; dup {
			conflicts = append(conflicts, fmt.Sprintf("value %v requested by both key %v and key %v", v, other, k))
			continue
		}
		seen[v] = k
		if _, ok := forward[k]; ok {
			conflicts = append(conflicts, fmt.Sprintf("key %v still present", k))
		}
		if holder, ok := reverse[v]; ok {
			conflicts = append(conflicts, fmt.Sprintf("value %v held by key %v", v, holder))
		}
	}
	if len(conflicts) > 0 {
		sort.Strings(conflicts)
		return &ConflictError{ValueConflicts: conflicts}
	}

	// Step 3: apply.
	for k, v := range t.sets {
		forward[k] = v
		reverse[v] = k
	}

	m.forward = forward
	m.reverse = reverse
	m.snapshots = append(m.snapshots, takeSnapshot(uint64(len(m.snapshots)), forward))
	return nil
}

// Snapshot is an immutable view of the table at a specific version.
type Snapshot[K comparable, V comparable] struct {
	version uint64
	forward map[K]V
	reverse map[V]K
}

func takeSnapshot[K comparable, V comparable](version uint64, forward map[K]V) Snapshot[K, V] {
	fwd := make(map[K]V, len(forward))
	rev := make(map[V]K, len(forward))
	for k, v := range forward {
		fwd[k] = v
		rev[v] = k
	}
	return Snapshot[K, V]{version: version, forward: fwd, reverse: rev}
}

// Version returns the version this snapshot was taken at.
func (s Snapshot[K, V]) Version() uint64 { return s.version }

// Get returns the value mapped to key k in this snapshot.
func (s Snapshot[K, V]) Get(k K) (V, bool) {
	v, ok := s.forward[k]
	return v, ok
}

// GetByValue returns the key mapped to value v in this snapshot.
func (s Snapshot[K, V]) GetByValue(v V) (K, bool) {
	k, ok := s.reverse[v]
	return k, ok
}

// Len returns the number of pairs in this snapshot.
func (s Snapshot[K, V]) Len() int { return len(s.forward) }

// Range calls fn for every key-value pair in this snapshot.
func (s Snapshot[K, V]) Range(fn func(k K, v V) bool) {
	for k, v := range s.forward {
		if !fn(k, v) {
			return
		}
	}
}
