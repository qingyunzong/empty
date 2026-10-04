package kvmerge

import (
	"fmt"
	"sort"
	"strings"
)

// Decision records the fate of one input entry during a merge.
type Decision struct {
	Entry  Entry
	Kept   bool
	Reason string
}

// Result is the merged segment plus a per-entry retention audit trail.
type Result struct {
	Segment   Segment
	Decisions []Decision
}

// Merge compacts layers (newest first) into a single segment.
//
// A version is kept when it is visible to at least one registered snapshot
// reader or to future readers (the newest version of its key). A tombstone
// is collected only when no old value can resurrect: every registered
// reader sits at a newer sequence than the tombstone, and mergesToBase
// guarantees no unmerged lower segment still holds older versions.
func Merge(layers []Segment, reg *Registry, mergesToBase bool) Result {
	byKey := make(map[string][]Entry)
	var keys []string
	for _, seg := range layers {
		for _, e := range seg.Entries {
			if _, ok := byKey[e.Key]; !ok {
				keys = append(keys, e.Key)
			}
			byKey[e.Key] = append(byKey[e.Key], e)
		}
	}
	sort.Strings(keys)

	readers := reg.Seqs()
	minReader, hasReaders := uint64(0), len(readers) > 0
	if hasReaders {
		minReader = readers[0]
	}

	var kept []Entry
	var decisions []Decision

	for _, k := range keys {
		vs := byKey[k]
		sort.Slice(vs, func(i, j int) bool { return vs[i].Seq > vs[j].Seq })

		// Whole-key tombstone collection: the newest version is a tombstone
		// older than every reader, and nothing below can resurrect a value.
		if mergesToBase && vs[0].Del && (!hasReaders || vs[0].Seq < minReader) {
			for _, v := range vs {
				decisions = append(decisions, Decision{Entry: v, Kept: false,
					Reason: fmt.Sprintf("collected: tombstone at seq %d is older than every reader and no lower segment can resurrect an old value", vs[0].Seq)})
			}
			continue
		}

		keep := make([]bool, len(vs))
		reasons := make([][]string, len(vs))
		addReason := func(i int, r string) {
			keep[i] = true
			reasons[i] = append(reasons[i], r)
		}

		if vs[0].Del {
			addReason(0, "newest version: tombstone must shadow older values for future readers")
		} else {
			addReason(0, "newest version: visible to future readers")
		}

		for _, r := range readers {
			if i := visibleIndex(vs, r); i >= 0 {
				addReason(i, fmt.Sprintf("visible to snapshot reader at seq %d", r))
			}
		}

		if !mergesToBase {
			for i, v := range vs {
				if v.Del && keep[i] {
					reasons[i] = append(reasons[i], "tombstone retained: unmerged lower segments may still hold older values")
				}
			}
		}

		for i, v := range vs {
			if keep[i] {
				kept = append(kept, v)
				decisions = append(decisions, Decision{Entry: v, Kept: true,
					Reason: strings.Join(reasons[i], "; ")})
				continue
			}
			reason := "superseded by a newer version and not visible to any registered reader"
			if v.Del {
				reason = "tombstone superseded by a newer version and not visible to any registered reader"
			} else if t, ok := nearestKeptTombstoneAbove(vs, keep, i); ok {
				reason = fmt.Sprintf("shadowed by retained tombstone at seq %d", t)
			}
			decisions = append(decisions, Decision{Entry: v, Kept: false, Reason: reason})
		}
	}

	return Result{Segment: NewSegment(kept), Decisions: decisions}
}

// visibleIndex returns the index of the newest version with Seq <= seq,
// or -1 when no version is that old. vs must be sorted by seq descending.
func visibleIndex(vs []Entry, seq uint64) int {
	for i, v := range vs {
		if v.Seq <= seq {
			return i
		}
	}
	return -1
}

// nearestKeptTombstoneAbove finds the closest kept tombstone newer than
// vs[i]; its seq explains why vs[i] can never be observed again.
func nearestKeptTombstoneAbove(vs []Entry, keep []bool, i int) (uint64, bool) {
	for j := i - 1; j >= 0; j-- {
		if vs[j].Del && keep[j] {
			return vs[j].Seq, true
		}
	}
	return 0, false
}
