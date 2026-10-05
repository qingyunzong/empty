// Package idem provides idempotent request execution keyed by
// (client, generation, sequence), with client-acknowledged reclamation
// watermarks and atomic cache/business commits.
//
// Protocol:
//   - A request carries a Key{ClientID, Generation, Seq}. The client bumps
//     Generation on restart and increases Seq monotonically within a
//     generation.
//   - The first execution of a key runs the business Op and caches its
//     decision (value + verdict) together with the business state change in
//     one atomic commit.
//   - A repeated key replays the cached decision (Duplicate) without
//     re-executing the Op.
//   - A key at or below the client's reclamation watermark, or belonging to
//     a stale generation, is answered Reclaimed: the record is gone and the
//     request is never re-executed.
//   - The watermark advances only through Ack, i.e. after the client has
//     confirmed receipt; execution alone never moves it.
package idem

import (
	"errors"
	"fmt"
	"sync"
)

// Key uniquely identifies a client request.
type Key struct {
	ClientID   string
	Generation uint64
	Seq        uint64
}

// Decision is the verdict returned for a submitted request.
type Decision int

const (
	// Executed means the business Op ran and this is its first result.
	Executed Decision = iota
	// Duplicate means the key was already executed; the original decision
	// is replayed and the Op is not run again.
	Duplicate
	// Reclaimed means the key is at or below the reclamation watermark (or
	// belongs to a stale generation); the original record has been
	// reclaimed and the request is not re-executed.
	Reclaimed
)

func (d Decision) String() string {
	switch d {
	case Executed:
		return "executed"
	case Duplicate:
		return "duplicate"
	case Reclaimed:
		return "reclaimed"
	default:
		return fmt.Sprintf("decision(%d)", int(d))
	}
}

// Op is a business operation executed against the business state S.
// It returns the next state, a result value, and a business verdict.
// On a non-nil verdict the returned state must be the unchanged input.
// The (value, verdict) pair is cached and replayed for duplicates.
type Op[S, V any] func(state S) (next S, value V, verdict error)

// Result is the outcome of Execute.
type Result[V any] struct {
	Decision Decision
	Value    V     // meaningful unless Decision is Reclaimed
	Verdict  error // business verdict, replayed on duplicates
}

// CrashPoint identifies the injection points used to simulate crashes.
type CrashPoint int

const (
	// CrashBeforeCacheWrite fires before the Op runs and the cache record
	// is prepared.
	CrashBeforeCacheWrite CrashPoint = iota
	// CrashBetweenCacheAndCommit fires after the Op has produced the cache
	// record and the next business state, immediately before the atomic
	// commit that installs both.
	CrashBetweenCacheAndCommit
	// CrashAfterCommit fires after the atomic commit, before Execute
	// returns to the caller.
	CrashAfterCommit
)

func (p CrashPoint) String() string {
	switch p {
	case CrashBeforeCacheWrite:
		return "before-cache-write"
	case CrashBetweenCacheAndCommit:
		return "between-cache-and-commit"
	case CrashAfterCommit:
		return "after-commit"
	default:
		return fmt.Sprintf("crash-point(%d)", int(p))
	}
}

var (
	// ErrStaleGeneration is returned by Ack for a generation older than the
	// client's current one.
	ErrStaleGeneration = errors.New("idem: ack for stale generation")
	// ErrAckBeyondExecuted is returned by Ack when seq exceeds the highest
	// sequence actually executed for the client generation.
	ErrAckBeyondExecuted = errors.New("idem: ack beyond highest executed sequence")
)

type record[V any] struct {
	value   V
	verdict error
}

type clientGen struct {
	clientID string
	gen      uint64
}

// Store executes Ops idempotently over a business state S.
type Store[S, V any] struct {
	mu         sync.Mutex
	state      S
	records    map[Key]record[V]
	watermark  map[clientGen]uint64
	maxSeq     map[clientGen]uint64
	currentGen map[string]uint64
	crashHook  func(CrashPoint) error
}

// New returns a Store with the given initial business state.
func New[S, V any](initial S) *Store[S, V] {
	return &Store[S, V]{
		state:      initial,
		records:    make(map[Key]record[V]),
		watermark:  make(map[clientGen]uint64),
		maxSeq:     make(map[clientGen]uint64),
		currentGen: make(map[string]uint64),
	}
}

// SetCrashHook installs a hook invoked at each CrashPoint; a non-nil return
// simulates a crash and aborts Execute with that error. Intended for tests.
func (s *Store[S, V]) SetCrashHook(hook func(CrashPoint) error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.crashHook = hook
}

// State returns the current business state.
func (s *Store[S, V]) State() S {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

// Watermark returns the reclamation watermark for a client generation.
func (s *Store[S, V]) Watermark(clientID string, generation uint64) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.watermark[clientGen{clientID, generation}]
}

// Execute submits a request. Exactly one of Decision's outcomes applies:
// the Op runs at most once per key, duplicates replay the cached decision,
// and reclaimed keys are never re-executed.
func (s *Store[S, V]) Execute(k Key, op Op[S, V]) (Result[V], error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if k.Generation < s.currentGen[k.ClientID] {
		return Result[V]{Decision: Reclaimed}, nil
	}
	s.currentGen[k.ClientID] = k.Generation

	cg := clientGen{k.ClientID, k.Generation}
	if k.Seq <= s.watermark[cg] {
		return Result[V]{Decision: Reclaimed}, nil
	}
	if rec, ok := s.records[k]; ok {
		return Result[V]{Decision: Duplicate, Value: rec.value, Verdict: rec.verdict}, nil
	}

	if err := s.crash(CrashBeforeCacheWrite); err != nil {
		return Result[V]{}, err
	}
	next, value, verdict := op(s.state)
	if err := s.crash(CrashBetweenCacheAndCommit); err != nil {
		return Result[V]{}, err
	}
	// Atomic commit: the cache record and the business state are installed
	// together under s.mu. There is deliberately no crash point between
	// them; that pairing is the atomicity invariant.
	s.records[k] = record[V]{value: value, verdict: verdict}
	s.state = next
	if k.Seq > s.maxSeq[cg] {
		s.maxSeq[cg] = k.Seq
	}
	if err := s.crash(CrashAfterCommit); err != nil {
		return Result[V]{}, err
	}
	return Result[V]{Decision: Executed, Value: value, Verdict: verdict}, nil
}

// Ack advances the reclamation watermark for (clientID, generation) to seq
// and reclaims cached records at or below it. The watermark moves only
// through Ack, after client confirmation, and never regresses.
func (s *Store[S, V]) Ack(clientID string, generation uint64, seq uint64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if generation < s.currentGen[clientID] {
		return ErrStaleGeneration
	}
	cg := clientGen{clientID, generation}
	if seq > s.maxSeq[cg] {
		return fmt.Errorf("%w: seq %d > max executed %d", ErrAckBeyondExecuted, seq, s.maxSeq[cg])
	}
	if seq <= s.watermark[cg] {
		return nil // already covered; acks are idempotent
	}
	s.watermark[cg] = seq
	for k := range s.records {
		if k.ClientID == clientID && k.Generation == generation && k.Seq <= seq {
			delete(s.records, k)
		}
	}
	return nil
}

func (s *Store[S, V]) crash(p CrashPoint) error {
	if s.crashHook == nil {
		return nil
	}
	return s.crashHook(p)
}
