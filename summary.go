package dataeng

import (
	"sort"
	"strconv"
)

// Summary is a mergeable shard snapshot. It keeps the full ID-to-item index,
// including items outside the retained sample, so no conflict can be hidden by
// sampling.
type Summary struct {
	k     int
	items map[string]Item
}

// K returns the sample size configured when the summary was produced.
func (m *Summary) K() int { return m.k }

// Len returns the number of distinct indexed items.
func (m *Summary) Len() int { return len(m.items) }

// Item returns the indexed item for id and whether it was recorded.
func (m *Summary) Item(id string) (Item, bool) {
	item, ok := m.items[id]
	return item, ok
}

// Snapshot returns an independent copy of the summary.
func (m *Summary) Snapshot() *Summary {
	items := make(map[string]Item, len(m.items))
	for id, item := range m.items {
		items[id] = item
	}
	return &Summary{k: m.k, items: items}
}

// Sample returns the K lowest-ranked indexed items in ascending rank order.
// It is equivalent to replaying every indexed item into a fresh sampler and
// reading its retained sample.
func (m *Summary) Sample() []Item {
	s := NewSampler(m.k)
	for _, item := range m.items {
		s.retain(item)
	}
	return s.Items()
}

// Sampler rebuilds an independent sampler preloaded with the indexed items,
// allowing a shard to resume collection after serialization.
func (m *Summary) Sampler() *Sampler {
	s := NewSampler(m.k)
	for id, item := range m.items {
		s.index[id] = item
		s.retain(item)
	}
	return s
}

// MergeError reports IDs whose content differs across merged summaries.
type MergeError struct {
	// Conflicts maps each conflicting ID to every distinct item observed for
	// it, sorted by Weight then Priority for deterministic reporting.
	Conflicts map[string][]Item
}

func (e *MergeError) Error() string {
	ids := make([]string, 0, len(e.Conflicts))
	for id := range e.Conflicts {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return "dataeng: merge conflicts for ids " + strconv.Quote(joinIDs(ids))
}

// IDs returns the conflicting IDs in byte order.
func (e *MergeError) IDs() []string {
	ids := make([]string, 0, len(e.Conflicts))
	for id := range e.Conflicts {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Merge combines shard summaries. The result is independent of shard
// assignment and merge order: identical re-submissions are ignored while any
// ID carrying differing content produces a *MergeError, even when that ID was
// never retained in any shard sample.
//
// All non-nil summaries must share the same K. When every summary is nil an
// empty K=0 summary is returned.
func Merge(summaries ...*Summary) (*Summary, error) {
	merged := make(map[string]Item)
	conflicts := make(map[string][]Item)
	k := 0
	haveK := false

	for _, shard := range summaries {
		if shard == nil {
			continue
		}
		if !haveK {
			k = shard.k
			haveK = true
		} else if shard.k != k {
			return nil, &MergeKError{Wanted: k, Got: shard.k}
		}
		for id, incoming := range shard.items {
			if existing, ok := merged[id]; ok {
				if existing == incoming {
					continue
				}
				appendConflict(conflicts, id, existing, incoming)
				continue
			}
			merged[id] = incoming
		}
	}
	if len(conflicts) > 0 {
		return nil, &MergeError{Conflicts: conflicts}
	}
	return &Summary{k: k, items: merged}, nil
}

// MergeKError reports an attempt to merge summaries with different K values.
type MergeKError struct {
	Wanted int
	Got    int
}

func (e *MergeKError) Error() string {
	return "dataeng: cannot merge summaries with different sample sizes: " +
		strconv.Itoa(e.Wanted) + " vs " + strconv.Itoa(e.Got)
}

func appendConflict(conflicts map[string][]Item, id string, items ...Item) {
	seen := make(map[Item]bool)
	all := append(append([]Item(nil), conflicts[id]...), items...)
	distinct := all[:0]
	for _, item := range all {
		if !seen[item] {
			seen[item] = true
			distinct = append(distinct, item)
		}
	}
	sort.Slice(distinct, func(i, j int) bool {
		if distinct[i].Weight != distinct[j].Weight {
			return distinct[i].Weight < distinct[j].Weight
		}
		if distinct[i].Priority != distinct[j].Priority {
			return distinct[i].Priority < distinct[j].Priority
		}
		return distinct[i].ID < distinct[j].ID
	})
	conflicts[id] = distinct
}

func joinIDs(ids []string) string {
	out := ""
	for i, id := range ids {
		if i > 0 {
			out += ", "
		}
		out += id
	}
	return out
}

func quoteID(id string) string { return strconv.Quote(id) }
