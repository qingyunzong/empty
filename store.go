// Package sessionstore implements a session-scoped key-value store with
// generation fencing. Every (re)connection obtains a new, strictly
// increasing generation. All operations carry their generation and a
// per-generation sequence number. Requests arriving from an older
// generation are rejected; a repeated sequence number within the current
// generation returns the original recorded result. Disconnecting never
// rolls back operations that were already committed.
package sessionstore

import (
	"errors"
	"fmt"
	"sync"
)

// ErrStaleGeneration is returned when an operation carries a generation
// older than the store's current generation.
var ErrStaleGeneration = errors.New("sessionstore: stale generation")

// Op is a single mutation to apply to the store.
type Op struct {
	Set   bool // true: set Key to Value; false: delete Key
	Key   string
	Value string
}

// Result is the outcome of applying an operation.
type Result struct {
	Seq uint64
	OK  bool
	Err error
}

// Store is a generation-fenced key-value store. Committed state survives
// reconnections; only the result cache is scoped to a generation.
type Store struct {
	mu      sync.Mutex
	gen     uint64            // current generation, incremented on every Connect
	data    map[string]string // committed state, never rolled back
	results map[uint64]Result // seq -> recorded result for the current generation
}

// NewStore returns an empty store.
func NewStore() *Store {
	return &Store{data: make(map[string]string)}
}

// Connect establishes a new session, bumping the store's generation and
// resetting the per-generation result cache. Previously committed state
// is preserved.
func (s *Store) Connect() *Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gen++
	s.results = make(map[uint64]Result)
	return &Session{store: s, gen: s.gen}
}

// Generation reports the store's current generation.
func (s *Store) Generation() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.gen
}

// Get reads committed state. It is generation-independent: committed data
// belongs to the store, not to any session.
func (s *Store) Get(key string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.data[key]
	return v, ok
}

// Snapshot returns a copy of all committed state.
func (s *Store) Snapshot() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]string, len(s.data))
	for k, v := range s.data {
		out[k] = v
	}
	return out
}

// Session is a handle bound to one generation of the store.
type Session struct {
	store *Store
	gen   uint64
}

// Generation returns the generation this session belongs to.
func (sess *Session) Generation() uint64 { return sess.gen }

// Apply executes op with the given per-generation sequence number.
//
// If the session's generation is older than the store's current
// generation (an in-flight request from before a reconnect), the
// operation is rejected with ErrStaleGeneration and no state changes.
// If seq was already applied in this generation, the original recorded
// result is returned and the operation is not re-applied.
func (sess *Session) Apply(seq uint64, op Op) Result {
	s := sess.store
	s.mu.Lock()
	defer s.mu.Unlock()

	if sess.gen != s.gen {
		return Result{Seq: seq, Err: fmt.Errorf("%w: op gen %d, current gen %d", ErrStaleGeneration, sess.gen, s.gen)}
	}
	if prev, dup := s.results[seq]; dup {
		return prev
	}
	if op.Set {
		s.data[op.Key] = op.Value
	} else {
		delete(s.data, op.Key)
	}
	res := Result{Seq: seq, OK: true}
	s.results[seq] = res
	return res
}
