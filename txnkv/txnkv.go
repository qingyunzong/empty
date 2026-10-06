// Package txnkv implements an optimistic, shard-versioned transactional
// key-value store.
//
// A transaction records the version and value of every shard it reads.
// At commit time the store is locked once: all read-shard versions are
// re-validated, and only if none changed are the write shards published
// atomically (readers never observe a partial commit). Writing the same
// value still bumps the shard version. Read-only transactions go through
// the same validation path.
package txnkv

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// ErrConflict is returned by Commit when a shard read by the transaction
// was modified by another committed transaction.
var ErrConflict = errors.New("txnkv: commit conflict, read shard changed")

type shard struct {
	value   string
	version uint64
}

// Store is a versioned, sharded key-value store.
type Store struct {
	mu     sync.Mutex
	shards map[string]shard
}

// NewStore returns an empty Store.
func NewStore() *Store {
	return &Store{shards: make(map[string]shard)}
}

// Version reports the current version of a shard (0 if never written).
func (s *Store) Version(key string) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.shards[key].version
}

// Load reads a shard outside of any transaction.
func (s *Store) Load(key string) (string, uint64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sh, ok := s.shards[key]
	return sh.value, sh.version, ok
}

// Snapshot returns a consistent copy of all shards (key -> value).
func (s *Store) Snapshot() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]string, len(s.shards))
	for k, sh := range s.shards {
		out[k] = sh.value
	}
	return out
}

type readRec struct {
	value   string
	version uint64
}

// Txn is a single-use optimistic transaction.
type Txn struct {
	store  *Store
	reads  map[string]readRec
	writes map[string]string
	done   bool
}

// Begin starts a new transaction on s.
func (s *Store) Begin() *Txn {
	return &Txn{
		store:  s,
		reads:  make(map[string]readRec),
		writes: make(map[string]string),
	}
}

// Get returns the value and version of key as seen by this transaction.
// Writes within the transaction are visible to its own reads.
func (t *Txn) Get(key string) (string, uint64, bool) {
	if v, ok := t.writes[key]; ok {
		_, ver, _ := t.readShard(key)
		return v, ver, true
	}
	return t.readShard(key)
}

func (t *Txn) readShard(key string) (string, uint64, bool) {
	if rec, ok := t.reads[key]; ok {
		return rec.value, rec.version, true
	}
	t.store.mu.Lock()
	sh, ok := t.store.shards[key]
	t.store.mu.Unlock()
	t.reads[key] = readRec{value: sh.value, version: sh.version}
	return sh.value, sh.version, ok
}

// Set stages a write to key. The shard version will be incremented at
// commit even if value equals the current value.
func (t *Txn) Set(key, value string) {
	t.writes[key] = value
}

// Commit validates every shard read by the transaction and, if none
// changed, atomically publishes all staged writes, bumping each written
// shard's version. On conflict nothing is written.
func (t *Txn) Commit() error {
	if t.done {
		return errors.New("txnkv: transaction already finished")
	}
	t.done = true

	s := t.store
	s.mu.Lock()
	defer s.mu.Unlock()

	// Phase 1: validate all read shards are unchanged.
	var changed []string
	for key, rec := range t.reads {
		if s.shards[key].version != rec.version {
			changed = append(changed, key)
		}
	}
	if len(changed) > 0 {
		sort.Strings(changed)
		return fmt.Errorf("%w: %s", ErrConflict, strings.Join(changed, ","))
	}

	// Phase 2: atomically publish write shards; same value still bumps.
	for key, v := range t.writes {
		sh := s.shards[key]
		sh.value = v
		sh.version++
		s.shards[key] = sh
	}
	return nil
}

// Rollback discards the transaction's staged writes.
func (t *Txn) Rollback() { t.done = true }
