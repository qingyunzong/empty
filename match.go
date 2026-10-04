// Package statmatch aligns two time series by one-to-one minimum
// time-difference matching under a rational maximum gap, and computes
// exact Pearson correlation statistics over the aligned pairs.
//
// Matching is always performed by the minimum-difference rule below;
// equal timestamps are never used as a shortcut. Every insertion or
// removal of a point re-runs the matching and recomputes the
// correlation.
package statmatch

import (
	"fmt"
	"math/big"
	"sort"
)

// MaxPoints is the maximum number of points per series admitted by an
// Aligner and covered by a Certificate.
const MaxPoints = 20

// Point is a single observation in a time series. IDs must be unique
// within a series. T must not be mutated after the point is in use.
type Point struct {
	ID string
	T  *big.Rat // rational timestamp
	V  int64    // observed value
}

// Pair is an aligned (matched) pair of points.
type Pair struct {
	A, B Point
	Diff *big.Rat // |A.T - B.T|
}

// edge is a candidate pair with its sort key.
type edge struct {
	i, j     int
	diff     *big.Rat
	aid, bid string
}

func lessEdge(p, q edge) bool {
	if c := p.diff.Cmp(q.diff); c != 0 {
		return c < 0
	}
	if p.aid != q.aid {
		return p.aid < q.aid
	}
	return p.bid < q.bid
}

// candidates lists every pair within maxGap, sorted by
// (time difference, A ID, B ID).
func candidates(a, b []Point, maxGap *big.Rat) []edge {
	var es []edge
	for i := range a {
		for j := range b {
			d := new(big.Rat).Sub(a[i].T, b[j].T)
			d.Abs(d)
			if d.Cmp(maxGap) <= 0 {
				es = append(es, edge{i, j, d, a[i].ID, b[j].ID})
			}
		}
	}
	sort.Slice(es, func(p, q int) bool { return lessEdge(es[p], es[q]) })
	return es
}

// Match pairs points of a and b one-to-one: candidate pairs within the
// rational maxGap are scanned in increasing (time difference, A ID,
// B ID) order and each candidate is matched when both endpoints are
// still free. The result is deterministic and independent of the input
// slice order.
func Match(a, b []Point, maxGap *big.Rat) []Pair {
	es := candidates(a, b, maxGap)
	usedA := make([]bool, len(a))
	usedB := make([]bool, len(b))
	var pairs []Pair
	for _, e := range es {
		if usedA[e.i] || usedB[e.j] {
			continue
		}
		usedA[e.i] = true
		usedB[e.j] = true
		pairs = append(pairs, Pair{A: a[e.i], B: b[e.j], Diff: e.diff})
	}
	return pairs
}

// maxEnumerationSide bounds each series for the independent enumeration
// cross-check, keeping the number of matchings tractable.
const maxEnumerationSide = 8

// VerifyMatchingByEnumeration independently enumerates every one-to-one
// matching between a and b within maxGap and confirms that exactly one
// of them satisfies the greedy characterization — every non-edge has an
// endpoint covered by a strictly smaller-key edge — and that this
// matching equals got (typically the output of Match).
func VerifyMatchingByEnumeration(a, b []Point, maxGap *big.Rat, got []Pair) error {
	if len(a) > maxEnumerationSide || len(b) > maxEnumerationSide ||
		len(a)+len(b) > 2*MaxPoints {
		return fmt.Errorf("statmatch: enumeration limit exceeded (%d + %d points)", len(a), len(b))
	}
	as := sortedByID(a)
	bs := sortedByID(b)
	es := candidates(as, bs, maxGap)

	adj := make([][]int, len(as)) // edge ranks per A index
	for r, e := range es {
		adj[e.i] = append(adj[e.i], r)
	}

	var good [][]int
	usedB := make([]bool, len(bs))
	var cur []int
	var recur func(i int)
	recur = func(i int) {
		if i == len(as) {
			if satisfiesGreedyProperty(es, cur, len(as), len(bs)) {
				good = append(good, append([]int(nil), cur...))
			}
			return
		}
		recur(i + 1) // leave as[i] unmatched
		for _, r := range adj[i] {
			j := es[r].j
			if usedB[j] {
				continue
			}
			usedB[j] = true
			cur = append(cur, r)
			recur(i + 1)
			cur = cur[:len(cur)-1]
			usedB[j] = false
		}
	}
	recur(0)

	if len(good) != 1 {
		return fmt.Errorf("statmatch: enumeration found %d greedy-consistent matchings, want exactly 1", len(good))
	}
	want := make(map[[2]string]bool, len(good[0]))
	for _, r := range good[0] {
		want[[2]string{es[r].aid, es[r].bid}] = true
	}
	if len(got) != len(want) {
		return fmt.Errorf("statmatch: greedy matching has %d pairs, enumeration %d", len(got), len(want))
	}
	for _, p := range got {
		if !want[[2]string{p.A.ID, p.B.ID}] {
			return fmt.Errorf("statmatch: greedy pair %s~%s not in enumerated matching", p.A.ID, p.B.ID)
		}
	}
	return nil
}

// satisfiesGreedyProperty reports whether the matching m (a list of
// edge ranks into es, which is sorted by key) has the greedy
// characterization: every candidate edge not in m has an endpoint
// covered by an edge of m with a strictly smaller key.
func satisfiesGreedyProperty(es []edge, m []int, na, nb int) bool {
	const inf = int(^uint(0) >> 1)
	inM := make(map[int]bool, len(m))
	minA := make([]int, na)
	minB := make([]int, nb)
	for i := range minA {
		minA[i] = inf
	}
	for j := range minB {
		minB[j] = inf
	}
	for _, r := range m {
		inM[r] = true
		if r < minA[es[r].i] {
			minA[es[r].i] = r
		}
		if r < minB[es[r].j] {
			minB[es[r].j] = r
		}
	}
	for r, e := range es {
		if inM[r] {
			continue
		}
		if minA[e.i] >= r && minB[e.j] >= r {
			return false
		}
	}
	return true
}

func sortedByID(ps []Point) []Point {
	out := append([]Point(nil), ps...)
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
