// Package sessionstore implements a session store with reconnect
// generations. Every reconnect yields a new, strictly increasing
// generation; all operations carry a generation and a per-generation
// sequence number. Requests from stale generations are rejected,
// duplicate sequence numbers within the current generation return the
// original result, and committed operations survive disconnects.
package sessionstore

import (
	"errors"
	"sync"
)

// ErrStaleGeneration is returned when an operation carries a generation
// other than the store's current generation.
var ErrStaleGeneration = errors.New("sessionstore: stale generation")

// Op is a single mutation: add Delta to the counter named Key.
type Op struct {
	Key   string
	Delta int
}

// Result is the outcome of an applied operation.
type Result struct {
	Generation uint64 // generation that produced this result
	Seq        uint64 // sequence number within that generation
	Value      int    // counter value after the operation
	Replayed   bool   // true if returned from the dedup cache, not re-applied
}

// Store is a goroutine-safe session store.
type Store struct {
	mu         sync.Mutex
	generation uint64
	state      map[string]int
	results    map[uint64]Result // dedup cache, valid for current generation only
}

// New returns an empty Store. The first Connect returns generation 1.
func New() *Store {
	return &Store{
		state:   make(map[string]int),
		results: make(map[uint64]Result),
	}
}

// Connect establishes a (re)connection: it bumps the generation and
// resets the per-generation dedup cache. Committed state is kept.
func (s *Store) Connect() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.generation++
	s.results = make(map[uint64]Result)
	return s.generation
}

// Generation reports the store's current generation.
func (s *Store) Generation() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.generation
}

// Apply executes op under (gen, seq). A stale gen is rejected. A seq
// already seen in the current generation returns the original result
// without re-applying the operation.
func (s *Store) Apply(gen, seq uint64, op Op) (Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if gen != s.generation {
		return Result{}, ErrStaleGeneration
	}
	if res, ok := s.results[seq]; ok {
		res.Replayed = true
		return res, nil
	}
	s.state[op.Key] += op.Delta
	res := Result{Generation: gen, Seq: seq, Value: s.state[op.Key]}
	s.results[seq] = res
	return res, nil
}

// State returns a snapshot of the committed state, but only to callers
// of the current generation.
func (s *Store) State(gen uint64) (map[string]int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if gen != s.generation {
		return nil, ErrStaleGeneration
	}
	snap := make(map[string]int, len(s.state))
	for k, v := range s.state {
		snap[k] = v
	}
	return snap, nil
}
