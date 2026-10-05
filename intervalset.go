// Package intervalset implements integer sets represented as canonical
// half-open intervals with source evidence, multi-set intersection
// queries, and incremental single-member corrections.
//
// A Set stores its members as a canonical list of half-open intervals
// [Lo, Hi): sorted, disjoint and non-adjacent. Every interval carries
// the sorted, unique source tags that evidence its membership; merging
// overlapping or adjacent intervals unions their tags, so normalization
// never loses provenance. Add and Remove correct a single member
// incrementally without rebuilding the whole interval list.
package intervalset

import (
	"fmt"
	"sort"
	"strings"
)

// Interval is a half-open range [Lo, Hi): Lo is included, Hi is excluded.
type Interval struct {
	Lo, Hi int
}

// Valid reports whether the interval is non-empty.
func (iv Interval) Valid() bool { return iv.Lo < iv.Hi }

// Contains reports whether x lies in [Lo, Hi).
func (iv Interval) Contains(x int) bool { return iv.Lo <= x && x < iv.Hi }

func (iv Interval) String() string { return fmt.Sprintf("[%d,%d)", iv.Lo, iv.Hi) }

// EInterval is a canonical interval annotated with the sorted, unique
// source tags that evidence its membership.
type EInterval struct {
	Interval
	Sources []string
}

// Evidence records one contributing set of an intersection result and
// the source tags carried by the contributing interval(s) of that set.
type Evidence struct {
	Set     string
	Sources []string
}

// RInterval is one interval of a query result together with its
// evidence: one entry per contributing set, sorted by set name.
type RInterval struct {
	Interval
	Evidence []Evidence
}

func (r RInterval) String() string {
	parts := make([]string, len(r.Evidence))
	for i, ev := range r.Evidence {
		parts[i] = ev.Set + ":" + strings.Join(ev.Sources, "+")
	}
	return fmt.Sprintf("%s<-%s", r.Interval, strings.Join(parts, ","))
}

// Set is a set of integers stored as a canonical list of evidence
// intervals.
type Set struct {
	name string
	ivs  []EInterval
}

// NewSet returns an empty set with the given name. The name is used as
// the set's identity in query evidence.
func NewSet(name string) *Set { return &Set{name: name} }

// Name returns the set name used in query evidence.
func (s *Set) Name() string { return s.name }

// Intervals returns a copy of the canonical interval list.
func (s *Set) Intervals() []EInterval {
	out := make([]EInterval, len(s.ivs))
	copy(out, s.ivs)
	return out
}

// Contains reports whether x is a member of the set.
func (s *Set) Contains(x int) bool {
	i := sort.Search(len(s.ivs), func(i int) bool { return s.ivs[i].Hi > x })
	return i < len(s.ivs) && s.ivs[i].Lo <= x
}

// AddInterval adds [iv.Lo, iv.Hi) tagged with src. Overlapping or
// adjacent existing intervals are merged into one and their source
// tags are unioned, so the list stays canonical and no evidence is
// lost.
func (s *Set) AddInterval(iv Interval, src string) {
	if !iv.Valid() {
		return
	}
	merged := EInterval{Interval: iv, Sources: []string{src}}
	out := make([]EInterval, 0, len(s.ivs)+1)
	i := 0
	for i < len(s.ivs) && s.ivs[i].Hi < merged.Lo {
		out = append(out, s.ivs[i])
		i++
	}
	for i < len(s.ivs) && s.ivs[i].Lo <= merged.Hi {
		merged.Lo = min(merged.Lo, s.ivs[i].Lo)
		merged.Hi = max(merged.Hi, s.ivs[i].Hi)
		merged.Sources = unionStrings(merged.Sources, s.ivs[i].Sources)
		i++
	}
	out = append(out, merged)
	s.ivs = append(out, s.ivs[i:]...)
}

// Add incrementally corrects the membership of the single element x,
// tagging it with src.
func (s *Set) Add(x int, src string) { s.AddInterval(Interval{Lo: x, Hi: x + 1}, src) }

// RemoveInterval removes [iv.Lo, iv.Hi), shrinking or splitting
// intervals as needed; surviving parts keep their source tags.
func (s *Set) RemoveInterval(iv Interval) {
	if !iv.Valid() || len(s.ivs) == 0 {
		return
	}
	// A split can grow the list by one, so compact into a fresh slice:
	// reusing the backing array would overwrite elements not yet read.
	out := make([]EInterval, 0, len(s.ivs)+1)
	for _, cur := range s.ivs {
		switch {
		case cur.Hi <= iv.Lo || cur.Lo >= iv.Hi:
			out = append(out, cur)
		default:
			if cur.Lo < iv.Lo {
				out = append(out, EInterval{Interval: Interval{Lo: cur.Lo, Hi: iv.Lo}, Sources: cur.Sources})
			}
			if cur.Hi > iv.Hi {
				out = append(out, EInterval{Interval: Interval{Lo: iv.Hi, Hi: cur.Hi}, Sources: cur.Sources})
			}
		}
	}
	s.ivs = out
}

// Remove incrementally corrects the membership of the single element x.
func (s *Set) Remove(x int) { s.RemoveInterval(Interval{Lo: x, Hi: x + 1}) }

func (s *Set) String() string {
	parts := make([]string, len(s.ivs))
	for i, e := range s.ivs {
		parts[i] = fmt.Sprintf("%s<%s>", e.Interval, strings.Join(e.Sources, "+"))
	}
	return s.name + "{" + strings.Join(parts, ",") + "}"
}

// Intersect returns the intervals covered by every input set. Adjacent
// result pieces are merged into one interval; each result keeps the
// per-set source evidence that produced it. Intersecting zero sets, or
// any empty set, yields nil.
func Intersect(sets ...*Set) []RInterval {
	if len(sets) == 0 {
		return nil
	}
	cur := make([]RInterval, 0, len(sets[0].ivs))
	for _, e := range sets[0].ivs {
		cur = append(cur, RInterval{
			Interval: e.Interval,
			Evidence: []Evidence{{Set: sets[0].name, Sources: unionStrings(nil, e.Sources)}},
		})
	}
	for _, s := range sets[1:] {
		next := make([]RInterval, 0, len(cur))
		for _, r := range cur {
			for _, e := range s.ivs {
				lo, hi := max(r.Lo, e.Lo), min(r.Hi, e.Hi)
				if lo < hi {
					next = append(next, RInterval{
						Interval: Interval{Lo: lo, Hi: hi},
						Evidence: unionEvidence(r.Evidence, []Evidence{{Set: s.name, Sources: e.Sources}}),
					})
				}
			}
		}
		cur = mergeAdjacent(next)
		if len(cur) == 0 {
			return nil
		}
	}
	return cur
}

// mergeAdjacent merges adjacent result pieces into one interval,
// unioning their evidence so provenance is preserved.
func mergeAdjacent(rs []RInterval) []RInterval {
	if len(rs) == 0 {
		return rs
	}
	out := rs[:1]
	for _, r := range rs[1:] {
		last := &out[len(out)-1]
		if last.Hi == r.Lo {
			last.Hi = r.Hi
			last.Evidence = unionEvidence(last.Evidence, r.Evidence)
		} else {
			out = append(out, r)
		}
	}
	return out
}

// Canonical reports whether ivs is in canonical form: valid, sorted,
// disjoint, non-adjacent intervals, each carrying non-empty, sorted,
// unique source tags.
func Canonical(ivs []EInterval) bool {
	for i, e := range ivs {
		if !e.Valid() || !sortedUnique(e.Sources) {
			return false
		}
		if i > 0 && ivs[i-1].Hi >= e.Lo {
			return false
		}
	}
	return true
}

// unionStrings returns the sorted union of two string slices.
func unionStrings(a, b []string) []string {
	set := make(map[string]struct{}, len(a)+len(b))
	for _, s := range a {
		set[s] = struct{}{}
	}
	for _, s := range b {
		set[s] = struct{}{}
	}
	out := make([]string, 0, len(set))
	for s := range set {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

// unionEvidence merges two evidence lists by set name, unioning the
// source tags of entries that refer to the same set. The result is
// sorted by set name.
func unionEvidence(a, b []Evidence) []Evidence {
	idx := make(map[string]int, len(a)+len(b))
	out := make([]Evidence, 0, len(a)+len(b))
	for _, ev := range a {
		idx[ev.Set] = len(out)
		out = append(out, Evidence{Set: ev.Set, Sources: unionStrings(nil, ev.Sources)})
	}
	for _, ev := range b {
		if i, ok := idx[ev.Set]; ok {
			out[i].Sources = unionStrings(out[i].Sources, ev.Sources)
		} else {
			idx[ev.Set] = len(out)
			out = append(out, Evidence{Set: ev.Set, Sources: unionStrings(nil, ev.Sources)})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Set < out[j].Set })
	return out
}

// sortedUnique reports whether ss is non-empty, sorted ascending and
// free of duplicates.
func sortedUnique(ss []string) bool {
	for i := 1; i < len(ss); i++ {
		if ss[i-1] >= ss[i] {
			return false
		}
	}
	return len(ss) > 0
}
