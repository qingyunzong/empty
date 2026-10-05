// Package coverage maintains weighted half-open integer intervals grouped
// by source ID and answers coverage queries: the coverage total (the
// integral of coverage over the line), the maximum coverage together with
// the earliest position reaching it, and the canonical segmentation into
// maximal constant-coverage segments, each carrying source evidence.
//
// The store supports cheap branch snapshots, batch modifications with
// inverse patches for undo, and crash-safe persistence based on atomic
// root publication.
package coverage

import "sort"

// Interval is a half-open integer interval [L, R) with signed weight W.
// Intervals with L >= R are empty and ignored by every operation.
type Interval struct {
	L, R int
	W    int64
}

// Segment is a maximal half-open range [L, R) of constant non-zero
// coverage Sum. Sources is the sorted, deduplicated evidence for the
// segment: the source IDs whose net weight contribution over [L, R) is
// non-zero.
type Segment struct {
	L, R    int
	Sum     int64
	Sources []string
}

// event is a signed weight change of one source at one coordinate.
type event struct {
	source string
	delta  int64
}

// segmentsFrom sweeps all interval endpoints and emits the canonical
// segmentation. Ranges with zero coverage are not emitted.
func segmentsFrom(srcs map[string][]Interval) []Segment {
	evs := make(map[int][]event)
	for src, ivs := range srcs {
		for _, iv := range ivs {
			if iv.L >= iv.R {
				continue
			}
			evs[iv.L] = append(evs[iv.L], event{src, iv.W})
			evs[iv.R] = append(evs[iv.R], event{src, -iv.W})
		}
	}
	if len(evs) == 0 {
		return nil
	}
	pos := make([]int, 0, len(evs))
	for p := range evs {
		pos = append(pos, p)
	}
	sort.Ints(pos)

	active := make(map[string]int64)
	var segs []Segment
	prev := pos[0]
	flush := func(cur int) {
		if cur <= prev || len(active) == 0 {
			return
		}
		var sum int64
		for _, w := range active {
			sum += w
		}
		if sum == 0 {
			return
		}
		evidence := make([]string, 0, len(active))
		for s := range active {
			evidence = append(evidence, s)
		}
		sort.Strings(evidence)
		segs = appendSeg(segs, Segment{L: prev, R: cur, Sum: sum, Sources: evidence})
	}
	apply := func(p int) {
		for _, e := range evs[p] {
			w := active[e.source] + e.delta
			if w == 0 {
				delete(active, e.source)
			} else {
				active[e.source] = w
			}
		}
	}
	apply(prev)
	for _, cur := range pos[1:] {
		flush(cur)
		apply(cur)
		prev = cur
	}
	return segs
}

// appendSeg appends s, merging it into the previous segment when they are
// adjacent with identical coverage and identical evidence.
func appendSeg(segs []Segment, s Segment) []Segment {
	if n := len(segs); n > 0 {
		if last := segs[n-1]; last.R == s.L && last.Sum == s.Sum && equalStrings(last.Sources, s.Sources) {
			segs[n-1].R = s.R
			return segs
		}
	}
	return append(segs, s)
}

func equalStrings(a, b []string) bool {
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
