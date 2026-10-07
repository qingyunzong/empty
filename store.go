// Package txnkv implements a sharded transactional key-value store using
// optimistic concurrency control: reads record shard versions, commit
// re-validates every read shard, and write shards are published atomically.
package txnkv

import (
	"errors"
	"sync"
)

// ErrConflict is returned by Commit when a shard read by the transaction
// changed before the transaction committed. No writes are applied.
var ErrConflict = errors.New("txnkv: read shard changed, transaction aborted")

// entry is a single shard: a value plus a monotonically increasing version.
// The version increments on every write, even when the value is unchanged.
type entry struct {
	value   string
	version uint64
}

// Store holds all shards. Validate+publish happen under one lock, so a
// commit is atomic: concurrent readers never observe a partial write set.
type Store struct {
	mu   sync.Mutex
	data map[string]entry

	// preCommit, when non-nil, runs in Commit before the store lock is
	// acquired. Tests use it as a barrier to deterministically interleave
	// transactions. It is not part of the public API.
	preCommit func()
}

// NewStore returns an empty store.
func NewStore() *Store {
	return &Store{data: make(map[string]entry)}
}

// Txn is a single-use transaction. It is not safe for concurrent use.
type Txn struct {
	store  *Store
	reads  map[string]entry // shard -> version+value observed at read time
	writes map[string]string
}

// Begin starts a new transaction on s.
func (s *Store) Begin() *Txn {
	return &Txn{
		store:  s,
		reads:  make(map[string]entry),
		writes: make(map[string]string),
	}
}

// Get returns the value of key. The shard's current version is recorded in
// the read set (including for missing keys, so concurrent creation of the
// key is also detected as a conflict). Writes by the same transaction are
// read-your-writes and do not extend the read set.
func (t *Txn) Get(key string) (string, bool) {
	if v, ok := t.writes[key]; ok {
		return v, true
	}
	t.store.mu.Lock()
	e, ok := t.store.data[key]
	t.store.mu.Unlock()
	if _, seen := t.reads[key]; !seen {
		t.reads[key] = e
	}
	return e.value, ok
}

// Set buffers a write to key. Nothing is published until Commit succeeds.
func (t *Txn) Set(key, value string) {
	t.writes[key] = value
}

// Commit validates every read shard against the store and, if all versions
// still match, atomically publishes the write set. Read-only transactions
// are validated too. On conflict nothing is written and ErrConflict is
// returned. Every published write increments the shard version, even when
// the new value equals the old one.
func (t *Txn) Commit() error {
	s := t.store
	if s.preCommit != nil {
		s.preCommit()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, want := range t.reads {
		if s.data[key].version != want.version {
			return ErrConflict
		}
	}
	for key, value := range t.writes {
		e := s.data[key]
		e.value = value
		e.version++
		s.data[key] = e
	}
	return nil
}

// Snapshot returns an atomic copy of all shards (value and version).
func (s *Store) Snapshot() map[string]struct {
	Value   string
	Version uint64
} {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]struct {
		Value   string
		Version uint64
	}, len(s.data))
	for k, e := range s.data {
		out[k] = struct {
			Value   string
			Version uint64
		}{e.value, e.version}
	}
	return out
}

// Version returns the current version of key and whether it exists.
func (s *Store) Version(key string) (uint64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.data[key]
	return e.version, ok
}
