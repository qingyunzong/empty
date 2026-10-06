// Package logindex provides an immutable byte-suffix index over an
// append-only log. Each Append produces a new Snapshot; previously
// returned snapshots are never modified, so queries against an old
// snapshot always observe the log exactly as it was when that snapshot
// was created.
package logindex

import (
	"bytes"
	"slices"
	"sort"
)

// Snapshot is an immutable view of the log at a point in time.
// The zero value is a valid empty snapshot.
type Snapshot struct {
	data []byte // log contents; never mutated after the snapshot is built
	sa   []int  // suffix array: offsets of data sorted by suffix order
}

// New returns an empty snapshot.
func New() *Snapshot {
	return &Snapshot{}
}

// Len reports the number of bytes visible in this snapshot.
func (s *Snapshot) Len() int {
	return len(s.data)
}

// Bytes returns a copy of the log contents visible in this snapshot.
func (s *Snapshot) Bytes() []byte {
	return bytes.Clone(s.data)
}

// Append returns a new snapshot whose log is this snapshot's log with
// chunk appended. The receiver is not modified; matches in the new
// snapshot may span the boundary between the old contents and chunk.
// The chunk is copied, so later mutation of the caller's slice is safe.
func (s *Snapshot) Append(chunk []byte) *Snapshot {
	data := make([]byte, len(s.data)+len(chunk))
	copy(data, s.data)
	copy(data[len(s.data):], chunk)

	sa := make([]int, len(data))
	for i := range sa {
		sa[i] = i
	}
	sort.Slice(sa, func(a, b int) bool {
		return bytes.Compare(data[sa[a]:], data[sa[b]:]) < 0
	})
	return &Snapshot{data: data, sa: sa}
}

// FindAll returns the offsets of every occurrence of pattern in this
// snapshot, in ascending order. Overlapping occurrences are all
// reported. An empty pattern matches nowhere and yields nil.
func (s *Snapshot) FindAll(pattern []byte) []int {
	if len(pattern) == 0 {
		return nil
	}
	data := s.data
	// has reports whether the suffix at offset i starts with pattern.
	has := func(i int) bool {
		return len(data)-i >= len(pattern) && bytes.Equal(data[i:i+len(pattern)], pattern)
	}
	// lo is the first suffix whose pattern-length prefix is >= pattern.
	lo := sort.Search(len(s.sa), func(k int) bool {
		suf := data[s.sa[k]:]
		if len(suf) > len(pattern) {
			suf = suf[:len(pattern)]
		}
		return bytes.Compare(suf, pattern) >= 0
	})
	// Every suffix from lo on that still has pattern as a prefix is a
	// match; they form a contiguous run in suffix-array order.
	var out []int
	for k := lo; k < len(s.sa) && has(s.sa[k]); k++ {
		out = append(out, s.sa[k])
	}
	slices.Sort(out)
	return out
}
