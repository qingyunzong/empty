// Package kvmerge merges layered key-value segments that carry
// multi-version values and tombstones, while honoring snapshot readers
// pinned at arbitrary registered sequence numbers.
package kvmerge

import "sort"

// Entry is a single versioned operation on a key.
// Del marks a tombstone; Val is meaningful only when Del is false.
type Entry struct {
	Key string
	Seq uint64
	Val string
	Del bool
}

// Segment is a sorted run of entries: key ascending, then seq descending.
type Segment struct {
	Entries []Entry
}

// NewSegment sorts entries into canonical segment order.
func NewSegment(entries []Entry) Segment {
	cp := make([]Entry, len(entries))
	copy(cp, entries)
	sort.Slice(cp, func(i, j int) bool {
		if cp[i].Key != cp[j].Key {
			return cp[i].Key < cp[j].Key
		}
		return cp[i].Seq > cp[j].Seq
	})
	return Segment{Entries: cp}
}

// Get returns the value visible at the given sequence number:
// the newest version with Seq <= seq. A tombstone yields found=false.
func (s Segment) Get(key string, seq uint64) (string, bool) {
	for _, e := range s.Entries {
		if e.Key < key {
			continue
		}
		if e.Key > key {
			break
		}
		if e.Seq <= seq {
			if e.Del {
				return "", false
			}
			return e.Val, true
		}
	}
	return "", false
}

// Registry tracks snapshot readers pinned at sequence numbers.
type Registry struct {
	counts map[uint64]int
}

func NewRegistry() *Registry {
	return &Registry{counts: make(map[uint64]int)}
}

func (r *Registry) Register(seq uint64) {
	r.counts[seq]++
}

func (r *Registry) Unregister(seq uint64) {
	if r.counts[seq] > 1 {
		r.counts[seq]--
		return
	}
	delete(r.counts, seq)
}

// Seqs returns the distinct registered reader sequences, ascending.
func (r *Registry) Seqs() []uint64 {
	out := make([]uint64, 0, len(r.counts))
	for s := range r.counts {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// Min returns the smallest registered reader sequence.
func (r *Registry) Min() (uint64, bool) {
	seqs := r.Seqs()
	if len(seqs) == 0 {
		return 0, false
	}
	return seqs[0], true
}
