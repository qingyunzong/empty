// Package cover merges edge coverage counters reported by multiple
// processes. An edge is identified by the digest of the source it was
// instrumented from plus a stable edge ID; counts belonging to
// different source digests are never mixed. Counters are 64-bit and
// overflow is reported as an error. Each run ID contributes at most
// once, so re-merging the same run is a no-op.
package cover

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/bits"
	"sort"
)

// Digest identifies one exact source build. Stable edge IDs are only
// meaningful within a single digest.
type Digest [sha256.Size]byte

// DigestOf hashes the given source parts into a Digest.
func DigestOf(parts ...[]byte) Digest {
	h := sha256.New()
	for _, p := range parts {
		h.Write(p)
	}
	var d Digest
	copy(d[:], h.Sum(nil))
	return d
}

func (d Digest) String() string {
	return hex.EncodeToString(d[:8])
}

// MarshalJSON encodes the digest as a hex string.
func (d Digest) MarshalJSON() ([]byte, error) {
	return json.Marshal(hex.EncodeToString(d[:]))
}

// UnmarshalJSON decodes a hex string digest.
func (d *Digest) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	raw, err := hex.DecodeString(s)
	if err != nil {
		return err
	}
	if len(raw) != sha256.Size {
		return fmt.Errorf("cover: bad digest length %d", len(raw))
	}
	copy(d[:], raw)
	return nil
}

var (
	// ErrDigestMismatch is returned when a delta carries a source
	// digest different from the store it is merged into.
	ErrDigestMismatch = errors.New("cover: source digest mismatch")
	// ErrOverflow is returned when a merge would push a 64-bit edge
	// counter past math.MaxUint64.
	ErrOverflow = errors.New("cover: 64-bit counter overflow")
)

// Delta is one process run's contribution: the per-edge hit counts
// observed during that run. RunID must be stable across retries of
// the same logical run so duplicates can be recognized.
type Delta struct {
	Digest Digest            `json:"digest"`
	RunID  uint64            `json:"run_id"`
	Edges  map[uint64]uint64 `json:"edges"`
}

// Store accumulates edge counts for exactly one source digest.
type Store struct {
	digest Digest
	runs   map[uint64]struct{}
	counts map[uint64]uint64
}

// NewStore returns an empty Store bound to source digest d.
func NewStore(d Digest) *Store {
	return &Store{
		digest: d,
		runs:   make(map[uint64]struct{}),
		counts: make(map[uint64]uint64),
	}
}

// Digest returns the source digest the store is bound to.
func (s *Store) Digest() Digest { return s.digest }

// Runs reports how many distinct run IDs have been merged.
func (s *Store) Runs() int { return len(s.runs) }

// Count returns the accumulated count for edge.
func (s *Store) Count(edge uint64) uint64 { return s.counts[edge] }

// Snapshot returns a copy of all accumulated edge counts.
func (s *Store) Snapshot() map[uint64]uint64 {
	out := make(map[uint64]uint64, len(s.counts))
	for id, c := range s.counts {
		out[id] = c
	}
	return out
}

// Edges returns the known edge IDs in ascending order.
func (s *Store) Edges() []uint64 {
	ids := make([]uint64, 0, len(s.counts))
	for id := range s.counts {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

// check reports whether d may be applied: false (without error) for
// an already-seen run ID, or an error for a foreign digest or a
// 64-bit overflow. The store is never modified.
func (s *Store) check(d Delta) (bool, error) {
	if d.Digest != s.digest {
		return false, fmt.Errorf("%w: store %s, delta %s", ErrDigestMismatch, s.digest, d.Digest)
	}
	if _, ok := s.runs[d.RunID]; ok {
		return false, nil
	}
	for id, c := range d.Edges {
		if _, carry := bits.Add64(s.counts[id], c, 0); carry != 0 {
			return false, fmt.Errorf("%w: edge %d", ErrOverflow, id)
		}
	}
	return true, nil
}

// apply folds d into the store. Callers must have validated d with
// check first.
func (s *Store) apply(d Delta) {
	for id, c := range d.Edges {
		s.counts[id] += c
	}
	s.runs[d.RunID] = struct{}{}
}

// Merge folds d into the store and reports whether it was applied.
// A delta whose run ID was already merged is dropped (applied=false,
// err=nil): every run counts exactly once. A delta with a foreign
// source digest fails with ErrDigestMismatch. If any edge count would
// overflow 64 bits, Merge fails with ErrOverflow and the store is
// left completely unchanged.
func (s *Store) Merge(d Delta) (bool, error) {
	ok, err := s.check(d)
	if err != nil || !ok {
		return ok, err
	}
	s.apply(d)
	return true, nil
}
