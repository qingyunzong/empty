// Package cover merges edge coverage counters emitted by multiple
// instrumented processes. Edge identity is the pair (source digest,
// stable edge ID); records from a different source digest are never
// mixed into a store. Counters are 64-bit and overflow is an error.
// Each run is applied at most once, keyed by its run ID.
package cover

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"math/bits"
	"sort"
)

// EdgeID is a stable identifier assigned to an edge by the instrumenter.
type EdgeID uint32

// Digest identifies the exact source the counters were generated from.
type Digest [sha256.Size]byte

// RunID uniquely identifies one instrumented run (one process execution).
type RunID [16]byte

// DigestOf returns the source digest for a blob of source code.
func DigestOf(src []byte) Digest { return Digest(sha256.Sum256(src)) }

var (
	// ErrSourceMismatch is returned when a record's source digest does
	// not match the store's digest; counts from different sources must
	// never be added together.
	ErrSourceMismatch = errors.New("cover: source digest mismatch")
	// ErrCountOverflow is returned when adding a count would overflow
	// the 64-bit edge counter.
	ErrCountOverflow = errors.New("cover: 64-bit edge count overflow")
)

// RunRecord carries the edge counts produced by a single run.
type RunRecord struct {
	RunID  RunID
	Source Digest
	Counts map[EdgeID]uint64
}

// Store accumulates edge counts for one source digest.
type Store struct {
	source    Digest
	hasSource bool
	seen      map[RunID]struct{}
	totals    map[EdgeID]uint64
}

// NewStore returns an empty store. The first merged record fixes the
// store's source digest.
func NewStore() *Store {
	return &Store{
		seen:   make(map[RunID]struct{}),
		totals: make(map[EdgeID]uint64),
	}
}

// Source reports the store's source digest and whether it is fixed yet.
func (s *Store) Source() (Digest, bool) { return s.source, s.hasSource }

// Merge applies one run record to the store. It reports whether the
// record was applied: records whose run ID was already merged are
// skipped (applied == false, err == nil). A source mismatch or a 64-bit
// overflow is an error and leaves the store unchanged.
func (s *Store) Merge(rec RunRecord) (applied bool, err error) {
	if s.hasSource && rec.Source != s.source {
		return false, fmt.Errorf("%w: record %x, store %x",
			ErrSourceMismatch, rec.Source[:8], s.source[:8])
	}
	if _, dup := s.seen[rec.RunID]; dup {
		return false, nil
	}
	// Validate overflow before mutating so a failed merge is atomic.
	for id, c := range rec.Counts {
		if _, carry := bits.Add64(s.totals[id], c, 0); carry != 0 {
			return false, fmt.Errorf("%w: edge %d", ErrCountOverflow, id)
		}
	}
	for id, c := range rec.Counts {
		s.totals[id] += c
	}
	s.seen[rec.RunID] = struct{}{}
	if !s.hasSource {
		s.source = rec.Source
		s.hasSource = true
	}
	return true, nil
}

// Total returns the accumulated count for an edge.
func (s *Store) Total(id EdgeID) uint64 { return s.totals[id] }

// Totals returns a copy of all accumulated edge counts.
func (s *Store) Totals() map[EdgeID]uint64 {
	out := make(map[EdgeID]uint64, len(s.totals))
	for id, c := range s.totals {
		out[id] = c
	}
	return out
}

// Runs reports how many distinct run IDs have been applied.
func (s *Store) Runs() int { return len(s.seen) }

// Edges returns the sorted list of edges with nonzero counts.
func (s *Store) Edges() []EdgeID {
	ids := make([]EdgeID, 0, len(s.totals))
	for id := range s.totals {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}
