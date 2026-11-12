// Package dataeng provides a deterministic, mergeable priority sampler for
// profile-service calls.
//
// Each recorded item carries a unique ID, a positive integer weight and a
// uint64 priority number. Items are ordered by the exact rational value
// priority/weight in ascending order; ties are broken by the byte order of
// the ID. A sampler keeps the smallest K items (K may be zero). Re-submitting
// an ID with identical content is ignored, while a differing content for a
// known ID is reported as a conflict.
//
// Shard summaries retain a full index of every observed item, not only the
// ones that made it into the retained sample. Merging summaries therefore
// detects conflicts for IDs that were never sampled and yields the same
// result as sampling all items on a single collector, independently of the
// sharding and merge order.
package dataeng

import (
	"errors"
	"math/bits"
)

// ErrZeroWeight is returned when an item whose weight is not a positive
// integer is added.
var ErrZeroWeight = errors.New("dataeng: item weight must be a positive integer")

// ConflictError reports that an item reuses an ID already recorded with
// different content. The sampler state is left untouched.
type ConflictError struct {
	ID string
	// Existing is the item first recorded under ID.
	Existing Item
	// Incoming is the rejected item carrying the same ID.
	Incoming Item
}

func (e *ConflictError) Error() string {
	return "dataeng: conflicting content for id " + quoteID(e.ID)
}

// Item is a recorded profile-service call.
type Item struct {
	ID       string
	Weight   uint64
	Priority uint64
}

// rankLess reports whether a ranks strictly before b: smaller exact rational
// Priority/Weight first, then smaller ID by byte order. The cross products
// are evaluated at 128-bit precision so no uint64 multiplication overflows.
func rankLess(a, b Item) bool {
	hiA, loA := bits.Mul64(a.Priority, b.Weight)
	hiB, loB := bits.Mul64(b.Priority, a.Weight)
	if hiA != hiB {
		return hiA < hiB
	}
	if loA != loB {
		return loA < loB
	}
	return a.ID < b.ID
}

// sampleHeap is a max-heap by rank: the worst (largest Priority/Weight, then
// largest ID) retained item sits at index 0, serving as the eviction
// threshold.
type sampleHeap []Item

func (h sampleHeap) Len() int           { return len(h) }
func (h sampleHeap) Less(i, j int) bool { return rankLess(h[j], h[i]) }
func (h sampleHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *sampleHeap) Push(x any)        { *h = append(*h, x.(Item)) }
func (h *sampleHeap) Pop() any {
	old := *h
	n := len(old)
	item := old[n-1]
	*h = old[:n-1]
	return item
}

// Sampler retains the K lowest-ranked unique items together with a complete
// content index of every item ever observed.
type Sampler struct {
	k      int
	index  map[string]Item
	sample sampleHeap
}

// NewSampler creates a sampler that retains the k lowest-ranked items. k must
// be non-negative; a negative k panics because it cannot name a valid sample
// size.
func NewSampler(k int) *Sampler {
	if k < 0 {
		panic("dataeng: sample size k must be non-negative")
	}
	return &Sampler{
		k:     k,
		index: make(map[string]Item),
	}
}

// K returns the configured sample size.
func (s *Sampler) K() int { return s.k }

// Len returns the number of distinct indexed items, including items that did
// not make it into the retained sample.
func (s *Sampler) Len() int { return len(s.index) }

// Add records an item. An identical re-submission (same ID and content) is a
// no-op; a re-submission with different content returns a *ConflictError and
// leaves the sampler unchanged; a zero weight returns ErrZeroWeight.
func (s *Sampler) Add(item Item) error {
	if item.Weight == 0 {
		return ErrZeroWeight
	}
	if existing, ok := s.index[item.ID]; ok {
		if existing == item {
			return nil
		}
		return &ConflictError{ID: item.ID, Existing: existing, Incoming: item}
	}
	s.index[item.ID] = item
	s.retain(item)
	return nil
}

// retain keeps the k lowest-ranked items across all accepted insertions.
func (s *Sampler) retain(item Item) {
	if s.k == 0 {
		return
	}
	if s.sample.Len() < s.k {
		heapPush(&s.sample, item)
		return
	}
	// Max-heap root is the worst retained item; replace it when the new item
	// ranks strictly better.
	if rankLess(item, s.sample[0]) {
		s.sample[0] = item
		heapFix(&s.sample, 0)
	}
}

// Items returns the retained sample ordered by ascending rank (smallest
// Priority/Weight first, ID byte order on ties). When fewer than K items were
// recorded the returned slice contains every accepted item.
func (s *Sampler) Items() []Item {
	return sortedSample(s.sample)
}

// Snapshot returns an independent, mergeable summary of every observed item.
// Subsequent additions to the sampler do not affect the returned summary.
func (s *Sampler) Snapshot() *Summary {
	items := make(map[string]Item, len(s.index))
	for id, item := range s.index {
		items[id] = item
	}
	return &Summary{k: s.k, items: items}
}
