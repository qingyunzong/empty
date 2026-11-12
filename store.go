package dataeng

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sync"
)

// MemoryStore is the reference transactional WindowStore. Commit never
// overwrites an existing ID and all returned byte slices are copies, so the
// caller and the interpreter cannot mutate stored state by accident.
type MemoryStore struct {
	mu      sync.RWMutex
	records map[string]Record

	// CommitFault, when non-nil, is returned from Commit instead of storing the
	// record. Tests use it to simulate an unknown commit outcome.
	CommitFault error
	// LookupFault, when non-nil, is returned from Lookup.
	LookupFault error

	Commits int
	Lookups int
}

// NewMemoryStore returns an empty in-memory store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{records: make(map[string]Record)}
}

// Lookup implements WindowStore.
func (s *MemoryStore) Lookup(_ context.Context, id string) (Record, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	s.Lookups++
	if s.LookupFault != nil {
		return Record{}, false, s.LookupFault
	}
	rec, ok := s.records[id]
	if !ok {
		return Record{}, false, nil
	}
	return cloneRecord(rec), true, nil
}

// Commit implements WindowStore. An existing ID causes ErrConflict instead of
// an overwrite.
func (s *MemoryStore) Commit(_ context.Context, id string, rec Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Commits++
	if s.CommitFault != nil {
		return s.CommitFault
	}
	if _, exists := s.records[id]; exists {
		return fmt.Errorf("%w: %q", ErrConflict, id)
	}
	s.records[id] = cloneRecord(rec)
	return nil
}

// Snapshot returns a deep copy of every stored record, keyed by ID.
func (s *MemoryStore) Snapshot() map[string]Record {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]Record, len(s.records))
	for id, rec := range s.records {
		out[id] = cloneRecord(rec)
	}
	return out
}

func cloneRecord(rec Record) Record {
	if rec.Target != nil {
		rec.Target = append([]byte(nil), rec.Target...)
	}
	return rec
}

// recordsEqual compares the identity fields used to reject a replayed window
// with different instructions or a different baseline.
func recordsEqual(stored, wanted Record) bool {
	return stored.BaselineSHA256 == wanted.BaselineSHA256 &&
		stored.InstructionHash == wanted.InstructionHash &&
		stored.TargetSHA256 == wanted.TargetSHA256 &&
		bytes.Equal(stored.Target, wanted.Target)
}

// commitOrRecover commits rec. If Commit returns an ambiguous error it looks
// the ID up: an identical record means the commit actually succeeded, a
// different record is a conflict, and an unresolvable lookup is surfaced as
// ErrAmbiguousCommit.
func commitOrRecover(ctx context.Context, store WindowStore, id string, rec Record) (committed bool, err error) {
	err = store.Commit(ctx, id, rec)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, ErrConflict) {
		return false, err
	}

	stored, ok, lookupErr := store.Lookup(ctx, id)
	if lookupErr != nil {
		return false, fmt.Errorf("%w: commit error %v; lookup error %v",
			ErrAmbiguousCommit, err, lookupErr)
	}
	if !ok {
		return false, fmt.Errorf("%w: commit error %v; id %q absent", ErrAmbiguousCommit, err, id)
	}
	if !recordsEqual(stored, rec) {
		return false, fmt.Errorf("%w: id %q recovered with different content", ErrConflict, id)
	}
	return false, nil
}
