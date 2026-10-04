// Package intervalx maintains a persistent (copy-on-write) collection of
// weighted, half-open integer intervals grouped by source ID, and answers
// coverage queries: point coverage sum, canonical segmentation, maximum
// coverage with its earliest position, and per-segment source evidence.
package intervalx

import (
	"sort"
)

// SourceID identifies the origin of intervals. A source may own many
// intervals; deleting a source withdraws all of them at once.
type SourceID string

// Interval is a half-open weighted interval [Lo, Hi). Zero-length
// intervals (Lo >= Hi) are ignored by every operation.
type Interval struct {
	Lo     int
	Hi     int
	Weight int64
}

// Version is an immutable snapshot of the interval set. Mutating methods
// return a new Version and never modify the receiver, so versions can be
// branched freely.
type Version struct {
	epoch uint64
	bySrc map[SourceID][]Interval
}

// New returns an empty Version with epoch 0.
func New() *Version {
	return &Version{bySrc: map[SourceID][]Interval{}}
}

// Epoch is a monotonically increasing identifier bumped by every
// derivation. It lets the persistent root detect stale or mixed slots.
func (v *Version) Epoch() uint64 { return v.epoch }

func (v *Version) clone() *Version {
	nv := &Version{epoch: v.epoch + 1, bySrc: make(map[SourceID][]Interval, len(v.bySrc))}
	for src, ivs := range v.bySrc {
		cp := make([]Interval, len(ivs))
		copy(cp, ivs)
		nv.bySrc[src] = cp
	}
	return nv
}

// Add returns a new Version with the interval [lo, hi) of the given weight
// attributed to src. Zero-length intervals are ignored.
func (v *Version) Add(src SourceID, lo, hi int, w int64) *Version {
	nv, _ := v.Apply([]Op{{Kind: OpAdd, Source: src, Interval: Interval{Lo: lo, Hi: hi, Weight: w}}})
	return nv
}

// DeleteSource returns a new Version with every interval owned by src
// withdrawn.
func (v *Version) DeleteSource(src SourceID) *Version {
	nv, _ := v.Apply([]Op{{Kind: OpDeleteSource, Source: src}})
	return nv
}

// SourcedInterval pairs an interval with its owning source.
type SourcedInterval struct {
	Source SourceID
	Interval
}

// Intervals returns a deterministically ordered flat view of all intervals.
func (v *Version) Intervals() []SourcedInterval {
	var out []SourcedInterval
	for src, ivs := range v.bySrc {
		for _, iv := range ivs {
			out = append(out, SourcedInterval{Source: src, Interval: iv})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Source != b.Source {
			return a.Source < b.Source
		}
		if a.Lo != b.Lo {
			return a.Lo < b.Lo
		}
		if a.Hi != b.Hi {
			return a.Hi < b.Hi
		}
		return a.Weight < b.Weight
	})
	return out
}

// Equal reports whether a and b hold the same multiset of intervals,
// independent of derivation history (epoch).
func Equal(a, b *Version) bool {
	ai, bi := a.Intervals(), b.Intervals()
	if len(ai) != len(bi) {
		return false
	}
	for i := range ai {
		if ai[i] != bi[i] {
			return false
		}
	}
	return true
}

// CoverageSumAt returns the sum of weights of all intervals covering x.
func (v *Version) CoverageSumAt(x int) int64 {
	var sum int64
	for _, ivs := range v.bySrc {
		for _, iv := range ivs {
			if iv.Lo <= x && x < iv.Hi {
				sum += iv.Weight
			}
		}
	}
	return sum
}

// Segment is a maximal half-open span with constant coverage sum.
type Segment struct {
	Lo, Hi int
	Sum    int64
}

// elementary splits the covered domain at every interval endpoint and
// returns, per elementary span, the coverage sum, the covering interval
// count, and the sorted set of contributing sources.
func (v *Version) elementary() (segs []Segment, counts []int, evidence [][]SourceID) {
	breaks := map[int]struct{}{}
	for _, ivs := range v.bySrc {
		for _, iv := range ivs {
			breaks[iv.Lo] = struct{}{}
			breaks[iv.Hi] = struct{}{}
		}
	}
	pts := make([]int, 0, len(breaks))
	for p := range breaks {
		pts = append(pts, p)
	}
	sort.Ints(pts)
	for i := 0; i+1 < len(pts); i++ {
		lo, hi := pts[i], pts[i+1]
		var sum int64
		var count int
		srcSeen := map[SourceID]struct{}{}
		var srcs []SourceID
		for src, ivs := range v.bySrc {
			for _, iv := range ivs {
				if iv.Lo <= lo && iv.Hi >= hi {
					sum += iv.Weight
					count++
					if _, ok := srcSeen[src]; !ok {
						srcSeen[src] = struct{}{}
						srcs = append(srcs, src)
					}
				}
			}
		}
		if count == 0 {
			continue
		}
		sort.Slice(srcs, func(a, b int) bool { return srcs[a] < srcs[b] })
		segs = append(segs, Segment{Lo: lo, Hi: hi, Sum: sum})
		counts = append(counts, count)
		evidence = append(evidence, srcs)
	}
	return segs, counts, evidence
}

// Segments returns the canonical segmentation of the covered domain:
// maximal half-open spans of constant coverage sum, ordered by position.
// Uncovered gaps are omitted.
func (v *Version) Segments() []Segment {
	elem, _, _ := v.elementary()
	var out []Segment
	for _, s := range elem {
		if n := len(out); n > 0 && out[n-1].Hi == s.Lo && out[n-1].Sum == s.Sum {
			out[n-1].Hi = s.Hi
			continue
		}
		out = append(out, s)
	}
	return out
}

// MaxCoverage returns the maximum coverage sum over all covered positions
// and the earliest position attaining it. ok is false when the set is
// empty; in that case max is defined as 0.
func (v *Version) MaxCoverage() (max int64, earliest int, ok bool) {
	segs := v.Segments()
	if len(segs) == 0 {
		return 0, 0, false
	}
	max = segs[0].Sum
	earliest = segs[0].Lo
	for _, s := range segs[1:] {
		if s.Sum > max {
			max = s.Sum
			earliest = s.Lo
		}
	}
	return max, earliest, true
}

// MaxSegment is a maximal span attaining the maximum coverage sum together
// with the sorted source IDs contributing to it.
type MaxSegment struct {
	Lo, Hi  int
	Sum     int64
	Sources []SourceID
}

// MaxSegments returns every maximal span attaining the maximum coverage
// sum, each annotated with its source evidence. Adjacent spans are merged
// only when their evidence sets are identical. Returns nil for an empty
// version.
func (v *Version) MaxSegments() []MaxSegment {
	max, _, ok := v.MaxCoverage()
	if !ok {
		return nil
	}
	elem, _, ev := v.elementary()
	var out []MaxSegment
	for i, s := range elem {
		if s.Sum != max {
			continue
		}
		if n := len(out); n > 0 && out[n-1].Hi == s.Lo && equalSources(out[n-1].Sources, ev[i]) {
			out[n-1].Hi = s.Hi
			continue
		}
		out = append(out, MaxSegment{Lo: s.Lo, Hi: s.Hi, Sum: s.Sum, Sources: ev[i]})
	}
	return out
}

func equalSources(a, b []SourceID) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
