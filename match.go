// Package statcorr computes Pearson correlation over aligned time series.
//
// Two point series are aligned by a one-to-one matching over rational
// timestamps: pairs must lie within a rational maximum gap, the matching
// maximizes the number of pairs, then minimizes the total absolute time
// difference, and remaining ties are broken by IDs. Statistics use exact
// integer arithmetic; the correlation coefficient is reported with a
// squarefree radical. Each series holds at most MaxPoints points.
package statcorr

import (
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strings"
)

// MaxPoints is the maximum number of points per series.
const MaxPoints = 20

// ErrTooManyPoints is returned when a series exceeds MaxPoints points.
var ErrTooManyPoints = errors.New("statcorr: series exceeds 20 points")

// ErrDuplicateID is returned when a series contains the same ID twice.
var ErrDuplicateID = errors.New("statcorr: duplicate point ID")

// Point is one observation: an ID, a rational timestamp and an integer value.
type Point struct {
	ID string
	T  *big.Rat
	V  *big.Int
}

// Pair links one point of series A with one point of series B.
type Pair struct {
	A, B Point
	Diff *big.Rat // |A.T - B.T|
}

// edge identifies a candidate pair by sorted-series indices.
type edge struct{ i, j int }

// Matching is the result of aligning two series.
type Matching struct {
	Pairs []Pair   // sorted by (A.ID, B.ID)
	Total *big.Rat // sum of pair diffs
}

// Match aligns series a and b one-to-one. A pair is allowed only when its
// absolute time difference does not exceed maxGap. Among all allowed
// matchings it selects:
//
//  1. maximum number of pairs,
//  2. minimum total time difference,
//  3. lexicographically smallest sorted (A.ID, B.ID) pair list.
//
// The optimal pair count and total difference come from a dynamic program
// over the time-sorted series (crossing pairs can always be uncrossed
// without increasing the total difference). The ID tie-break is then
// resolved exactly: candidate pairs are considered in (A.ID, B.ID) order
// and each is kept iff some optimal matching still contains it, which
// yields the lexicographically smallest optimal pair list.
func Match(as, bs []Point, maxGap *big.Rat) (Matching, error) {
	if len(as) > MaxPoints || len(bs) > MaxPoints {
		return Matching{}, ErrTooManyPoints
	}
	a, err := sortByTime(as)
	if err != nil {
		return Matching{}, err
	}
	b, err := sortByTime(bs)
	if err != nil {
		return Matching{}, err
	}
	n, m := len(a), len(b)
	diff := make([][]*big.Rat, n) // nil when the pair exceeds the gap
	for i := range diff {
		diff[i] = make([]*big.Rat, m)
		for j := range diff[i] {
			d := new(big.Rat).Sub(a[i].T, b[j].T)
			d.Abs(d)
			if d.Cmp(maxGap) <= 0 {
				diff[i][j] = d
			}
		}
	}
	allA, allB := make([]int, n), make([]int, m)
	for i := range allA {
		allA[i] = i
	}
	for j := range allB {
		allB[j] = j
	}
	card, total := solveMatching(diff, allA, allB, nil)
	if card == 0 {
		return Matching{Total: new(big.Rat)}, nil
	}
	var cands []edge
	for i := 0; i < n; i++ {
		for j := 0; j < m; j++ {
			if diff[i][j] != nil {
				cands = append(cands, edge{i, j})
			}
		}
	}
	sort.Slice(cands, func(x, y int) bool {
		if a[cands[x].i].ID != a[cands[y].i].ID {
			return a[cands[x].i].ID < a[cands[y].i].ID
		}
		return b[cands[x].j].ID < b[cands[y].j].ID
	})
	usedA := make([]bool, n)
	usedB := make([]bool, m)
	forbidden := make(map[edge]bool)
	remA, remB := allA, allB
	costF := new(big.Rat)
	var pairs []Pair
	for _, c := range cands {
		if usedA[c.i] || usedB[c.j] {
			continue
		}
		nextA, nextB := without(remA, c.i), without(remB, c.j)
		gotCard, gotCost := solveMatching(diff, nextA, nextB, forbidden)
		needCost := new(big.Rat).Sub(new(big.Rat).Sub(total, costF), diff[c.i][c.j])
		if gotCard == card-len(pairs)-1 && gotCost.Cmp(needCost) == 0 {
			pairs = append(pairs, Pair{A: a[c.i], B: b[c.j], Diff: diff[c.i][c.j]})
			usedA[c.i], usedB[c.j] = true, true
			costF.Add(costF, diff[c.i][c.j])
			remA, remB = nextA, nextB
		} else {
			forbidden[c] = true
		}
	}
	return Matching{Pairs: pairs, Total: total}, nil
}

// solveMatching returns the maximum number of pairs and, among matchings of
// that size, the minimum total difference, over the given remaining index
// sets. Edges in forbidden are disallowed.
func solveMatching(diff [][]*big.Rat, remA, remB []int, forbidden map[edge]bool) (int, *big.Rat) {
	n, m := len(remA), len(remB)
	type state struct {
		card int
		cost *big.Rat
	}
	dp := make([][]state, n+1)
	for i := range dp {
		dp[i] = make([]state, m+1)
		for j := range dp[i] {
			dp[i][j] = state{card: 0, cost: new(big.Rat)}
		}
	}
	better := func(x, y state) bool {
		if x.card != y.card {
			return x.card > y.card
		}
		return x.cost.Cmp(y.cost) < 0
	}
	for i := 1; i <= n; i++ {
		for j := 1; j <= m; j++ {
			best := dp[i][j-1]
			if better(dp[i-1][j], best) {
				best = dp[i-1][j]
			}
			gi, gj := remA[i-1], remB[j-1]
			if d := diff[gi][gj]; d != nil && !forbidden[edge{gi, gj}] {
				prev := dp[i-1][j-1]
				cand := state{card: prev.card + 1, cost: new(big.Rat).Add(prev.cost, d)}
				if better(cand, best) {
					best = cand
				}
			}
			dp[i][j] = best
		}
	}
	return dp[n][m].card, dp[n][m].cost
}

func without(xs []int, v int) []int {
	out := make([]int, 0, len(xs)-1)
	for _, x := range xs {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}

// Certificate renders a deterministic, verifiable description of the
// matching: pair count, total difference, and one line per pair.
func (m Matching) Certificate() string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "matching pairs=%d total=%s\n", len(m.Pairs), m.Total.RatString())
	for _, p := range m.Pairs {
		fmt.Fprintf(&sb, "pair %s(t=%s,v=%s) <-> %s(t=%s,v=%s) diff=%s\n",
			p.A.ID, p.A.T.RatString(), p.A.V.String(),
			p.B.ID, p.B.T.RatString(), p.B.V.String(),
			p.Diff.RatString())
	}
	return sb.String()
}

func sortByTime(pts []Point) ([]Point, error) {
	seen := make(map[string]bool, len(pts))
	for _, p := range pts {
		if seen[p.ID] {
			return nil, ErrDuplicateID
		}
		seen[p.ID] = true
	}
	out := make([]Point, len(pts))
	copy(out, pts)
	sort.Slice(out, func(i, j int) bool {
		if c := out[i].T.Cmp(out[j].T); c != 0 {
			return c < 0
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}
