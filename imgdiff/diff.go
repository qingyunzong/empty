package imgdiff

import "sort"

// Interval is a half-open range [Start, End).
type Interval struct {
	Start uint64 `json:"start"`
	End   uint64 `json:"end"`
}

// segState is the resolved state of one image over an elementary segment.
type segState struct {
	data   bool
	digest string
	zero   bool
}

// readsZero reports whether the segment's logical content is all zero,
// either because it is a hole or because it is a zero-filled data extent.
func (s segState) readsZero() bool { return !s.data || s.zero }

// contentEqual compares the logical bytes two images would read.
func contentEqual(a, b segState) bool {
	if a.readsZero() || b.readsZero() {
		return a.readsZero() && b.readsZero()
	}
	return a.digest == b.digest
}

// layoutEqual compares the on-disk layout: both holes, or both data with
// equal content. A zero data extent and a hole read the same bytes but
// have different layouts.
func layoutEqual(a, b segState) bool {
	if a.data != b.data {
		return false
	}
	if !a.data {
		return true
	}
	return contentEqual(a, b)
}

// Diff compares two flattened extent lists over [0, max(sizeA, sizeB)) and
// returns the maximal half-open intervals where the images differ, once by
// logical content (holes read as zero) and once by on-disk layout (hole vs
// data, or data with different content). Content differences are a subset
// of layout differences.
func Diff(a []Extent, sizeA uint64, b []Extent, sizeB uint64) (content, layout []Interval) {
	size := sizeA
	if sizeB > size {
		size = sizeB
	}
	bounds := []uint64{0, size}
	for _, e := range a {
		bounds = append(bounds, e.Start, e.End)
	}
	for _, e := range b {
		bounds = append(bounds, e.Start, e.End)
	}
	sort.Slice(bounds, func(i, j int) bool { return bounds[i] < bounds[j] })
	bounds = uniq(bounds)

	var contentDiff, layoutDiff []Interval
	ia, ib := 0, 0
	for i := 0; i+1 < len(bounds); i++ {
		lo, hi := bounds[i], bounds[i+1]
		for ia < len(a) && a[ia].End <= lo {
			ia++
		}
		for ib < len(b) && b[ib].End <= lo {
			ib++
		}
		var sa, sb segState
		if ia < len(a) && a[ia].Data && a[ia].Start <= lo && lo < a[ia].End {
			sa = segState{data: true, digest: a[ia].Digest, zero: a[ia].Zero}
		}
		if ib < len(b) && b[ib].Data && b[ib].Start <= lo && lo < b[ib].End {
			sb = segState{data: true, digest: b[ib].Digest, zero: b[ib].Zero}
		}
		if !contentEqual(sa, sb) {
			contentDiff = appendInterval(contentDiff, lo, hi)
		}
		if !layoutEqual(sa, sb) {
			layoutDiff = appendInterval(layoutDiff, lo, hi)
		}
	}
	return contentDiff, layoutDiff
}

// appendInterval extends the last interval if adjacent, keeping the output
// as a list of maximal half-open intervals.
func appendInterval(iv []Interval, lo, hi uint64) []Interval {
	if n := len(iv); n > 0 && iv[n-1].End == lo {
		iv[n-1].End = hi
		return iv
	}
	return append(iv, Interval{Start: lo, End: hi})
}

func uniq(v []uint64) []uint64 {
	out := v[:0]
	for i, x := range v {
		if i == 0 || x != v[i-1] {
			out = append(out, x)
		}
	}
	return out
}
