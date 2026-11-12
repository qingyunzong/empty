package dataeng

import (
	"math/big"
	"math/rand"
	"reflect"
	"testing"
)

func rat(num, den int64) *big.Rat { return big.NewRat(num, den) }

func TestMergeOverlappingAndAdjacent(t *testing.T) {
	res, err := Plan([]Interval{{8, 10}, {0, 3}, {3, 5}, {4, 6}, {12, 13}},
		Params{FileLen: 20, MaxSpan: 100, Fixed: rat(1, 1), PerByte: rat(0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	want := []Interval{{0, 6}, {8, 10}, {12, 13}}
	if !reflect.DeepEqual(res.Merged, want) {
		t.Fatalf("merged = %v, want %v", res.Merged, want)
	}
}

func TestHighFixedCostMergesAcrossGaps(t *testing.T) {
	// Two intervals with a gap of 4; fixed cost dominates, so one
	// request reading the gap is cheapest.
	res, err := Plan([]Interval{{0, 5}, {9, 10}},
		Params{FileLen: 10, MaxSpan: 10, Fixed: rat(100, 1), PerByte: rat(1, 1)})
	if err != nil {
		t.Fatal(err)
	}
	want := []Interval{{0, 10}}
	if !reflect.DeepEqual(res.Requests, want) {
		t.Fatalf("requests = %v, want %v", res.Requests, want)
	}
	if res.Cost.Cmp(rat(110, 1)) != 0 {
		t.Fatalf("cost = %v, want 110", res.Cost)
	}
	if !reflect.DeepEqual(res.Covers, [][]int{{0, 1}}) {
		t.Fatalf("covers = %v", res.Covers)
	}
}

func TestHighPerByteCostSplitsAtGap(t *testing.T) {
	res, err := Plan([]Interval{{0, 5}, {9, 10}},
		Params{FileLen: 10, MaxSpan: 10, Fixed: rat(1, 1), PerByte: rat(100, 1)})
	if err != nil {
		t.Fatal(err)
	}
	want := []Interval{{0, 5}, {9, 10}}
	if !reflect.DeepEqual(res.Requests, want) {
		t.Fatalf("requests = %v, want %v", res.Requests, want)
	}
	if res.Cost.Cmp(rat(602, 1)) != 0 {
		t.Fatalf("cost = %v, want 602", res.Cost)
	}
}

func TestSpanLimitForcesSplit(t *testing.T) {
	res, err := Plan([]Interval{{0, 4}, {6, 10}},
		Params{FileLen: 10, MaxSpan: 7, Fixed: rat(0, 1), PerByte: rat(1, 1)})
	if err != nil {
		t.Fatal(err)
	}
	want := []Interval{{0, 4}, {6, 10}}
	if !reflect.DeepEqual(res.Requests, want) {
		t.Fatalf("requests = %v, want %v", res.Requests, want)
	}
}

func TestTieBreakFewerRequestsThenLex(t *testing.T) {
	// Zero costs: every partition costs 0. Fewest requests wins, and
	// the lexicographically smallest list among those is chosen.
	res, err := Plan([]Interval{{0, 2}, {4, 6}, {8, 10}},
		Params{FileLen: 10, MaxSpan: 6, Fixed: rat(0, 1), PerByte: rat(0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	// M=6 allows {[0,6],[8,10]} or {[0,2],[4,10]} (2 requests each);
	// [0,2] < [0,6] at the first element, so the second list wins.
	want := []Interval{{0, 2}, {4, 10}}
	if !reflect.DeepEqual(res.Requests, want) {
		t.Fatalf("requests = %v, want %v", res.Requests, want)
	}
}

func TestRationalCostArithmetic(t *testing.T) {
	// fixed=1/3, per-byte=1/7; single request of span 4 -> 1/3+4/7=19/21.
	res, err := Plan([]Interval{{2, 6}},
		Params{FileLen: 10, MaxSpan: 10, Fixed: rat(1, 3), PerByte: rat(1, 7)})
	if err != nil {
		t.Fatal(err)
	}
	if res.Cost.Cmp(rat(19, 21)) != 0 {
		t.Fatalf("cost = %v, want 19/21", res.Cost)
	}
}

func TestInfeasibleReportsTooLong(t *testing.T) {
	res, err := Plan([]Interval{{0, 3}, {5, 20}, {30, 31}, {40, 60}},
		Params{FileLen: 100, MaxSpan: 10, Fixed: rat(1, 1), PerByte: rat(1, 1)})
	if err != nil {
		t.Fatal(err)
	}
	if res.Feasible {
		t.Fatal("expected infeasible")
	}
	want := []Interval{{5, 20}, {40, 60}}
	if !reflect.DeepEqual(res.TooLong, want) {
		t.Fatalf("tooLong = %v, want %v", res.TooLong, want)
	}
	if res.Requests != nil || res.Cost != nil {
		t.Fatalf("expected no plan, got %v cost %v", res.Requests, res.Cost)
	}
}

func TestCoversMapsToOriginalIndices(t *testing.T) {
	res, err := Plan([]Interval{{8, 9}, {0, 2}, {1, 3}, {5, 6}},
		Params{FileLen: 10, MaxSpan: 3, Fixed: rat(1, 1), PerByte: rat(0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	want := [][]int{{1, 2}, {3}, {0}}
	if !reflect.DeepEqual(res.Covers, want) {
		t.Fatalf("covers = %v, want %v", res.Covers, want)
	}
}

func TestInvalidInput(t *testing.T) {
	p := Params{FileLen: 10, MaxSpan: 5, Fixed: rat(1, 1), PerByte: rat(0, 1)}
	if _, err := Plan([]Interval{{3, 3}}, p); err == nil {
		t.Fatal("empty interval accepted")
	}
	if _, err := Plan([]Interval{{0, 11}}, p); err == nil {
		t.Fatal("out-of-file interval accepted")
	}
	if _, err := Plan([]Interval{{-1, 2}}, p); err == nil {
		t.Fatal("negative start accepted")
	}
	p2 := p
	p2.MaxSpan = 0
	if _, err := Plan([]Interval{{0, 1}}, p2); err == nil {
		t.Fatal("non-positive MaxSpan accepted")
	}
	p3 := p
	p3.Fixed = rat(-1, 2)
	if _, err := Plan([]Interval{{0, 1}}, p3); err == nil {
		t.Fatal("negative fixed cost accepted")
	}
}

// bruteForce enumerates every contiguous partition of the merged
// intervals (all 2^(n-1) compositions), keeps groups whose span fits
// MaxSpan, and returns the best (cost, count, lexicographic) plan.
func bruteForce(merged []Interval, p Params) ([]Interval, *big.Rat) {
	n := len(merged)
	var bestReqs []Interval
	var bestCost *big.Rat
	var rec func(pos int, reqs []Interval, cost *big.Rat)
	rec = func(pos int, reqs []Interval, cost *big.Rat) {
		if pos == n {
			if bestCost == nil || cost.Cmp(bestCost) < 0 ||
				(cost.Cmp(bestCost) == 0 && (len(reqs) < len(bestReqs) ||
					(len(reqs) == len(bestReqs) && lessIntervals(reqs, bestReqs)))) {
				bestCost = new(big.Rat).Set(cost)
				bestReqs = append([]Interval{}, reqs...)
			}
			return
		}
		for j := pos; j < n; j++ {
			span := merged[j].End - merged[pos].Start
			if span > p.MaxSpan {
				break
			}
			gc := new(big.Rat).Add(new(big.Rat).Mul(p.PerByte, big.NewRat(span, 1)), p.Fixed)
			rec(j+1, append(reqs, Interval{merged[pos].Start, merged[j].End}),
				new(big.Rat).Add(cost, gc))
		}
	}
	rec(0, nil, new(big.Rat))
	return bestReqs, bestCost
}

// TestExhaustivePartitions cross-checks Plan against brute-force
// enumeration of all contiguous partitions on small random instances,
// and validates the structural invariants of every plan.
func TestExhaustivePartitions(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	for trial := 0; trial < 400; trial++ {
		fileLen := int64(1 + rng.Intn(24))
		maxSpan := int64(1 + rng.Intn(12))
		nReq := 1 + rng.Intn(6)
		reqs := make([]Interval, nReq)
		for i := range reqs {
			s := rng.Int63n(fileLen)
			e := s + 1 + rng.Int63n(fileLen-s)
			reqs[i] = Interval{s, e}
		}
		p := Params{
			FileLen: fileLen,
			MaxSpan: maxSpan,
			Fixed:   rat(int64(rng.Intn(5)), int64(1+rng.Intn(4))),
			PerByte: rat(int64(rng.Intn(5)), int64(1+rng.Intn(4))),
		}
		res, err := Plan(reqs, p)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}

		// Infeasibility must match the merged-interval lengths exactly.
		var tooLong []Interval
		for _, iv := range res.Merged {
			if iv.Len() > maxSpan {
				tooLong = append(tooLong, iv)
			}
		}
		if len(tooLong) > 0 {
			if res.Feasible || !reflect.DeepEqual(res.TooLong, tooLong) {
				t.Fatalf("trial %d: feasible=%v tooLong=%v want %v",
					trial, res.Feasible, res.TooLong, tooLong)
			}
			continue
		}
		if !res.Feasible {
			t.Fatalf("trial %d: unexpectedly infeasible", trial)
		}

		// Compare against exhaustive enumeration of all partitions.
		wantReqs, wantCost := bruteForce(res.Merged, p)
		if res.Cost.Cmp(wantCost) != 0 {
			t.Fatalf("trial %d: cost %v, brute force %v (merged=%v params=%+v)",
				trial, res.Cost, wantCost, res.Merged, p)
		}
		if !reflect.DeepEqual(res.Requests, wantReqs) {
			t.Fatalf("trial %d: requests %v, brute force %v (merged=%v params=%+v)",
				trial, res.Requests, wantReqs, res.Merged, p)
		}

		checkInvariants(t, trial, reqs, res, p)
	}
}

func checkInvariants(t *testing.T, trial int, reqs []Interval, res Result, p Params) {
	t.Helper()
	// Requests are sorted, disjoint, inside the file, within MaxSpan,
	// and their boundaries come from merged-interval boundaries.
	bounds := map[int64]bool{}
	for _, iv := range res.Merged {
		bounds[iv.Start] = true
		bounds[iv.End] = true
	}
	prevEnd := int64(0)
	for k, r := range res.Requests {
		if k > 0 && r.Start < prevEnd {
			t.Fatalf("trial %d: requests overlap or unordered: %v", trial, res.Requests)
		}
		prevEnd = r.End
		if r.Start < 0 || r.End > p.FileLen {
			t.Fatalf("trial %d: request %v crosses file endpoint", trial, r)
		}
		if r.End-r.Start > p.MaxSpan {
			t.Fatalf("trial %d: request %v exceeds MaxSpan", trial, r)
		}
		if !bounds[r.Start] || !bounds[r.End] {
			t.Fatalf("trial %d: request %v not on merged boundaries", trial, r)
		}
	}
	// Every original requirement is covered by exactly one request.
	seen := map[int]int{}
	for _, idxs := range res.Covers {
		for _, idx := range idxs {
			seen[idx]++
		}
	}
	if len(seen) != len(reqs) {
		t.Fatalf("trial %d: covers %v misses requirements", trial, res.Covers)
	}
	for idx, cnt := range seen {
		if cnt != 1 {
			t.Fatalf("trial %d: requirement %d covered %d times", trial, idx, cnt)
		}
	}
	// Each request actually contains the requirements it claims.
	for k, idxs := range res.Covers {
		for _, idx := range idxs {
			iv := reqs[idx]
			r := res.Requests[k]
			if iv.Start < r.Start || iv.End > r.End {
				t.Fatalf("trial %d: request %v does not cover requirement %v",
					trial, r, iv)
			}
		}
	}
	// Reported cost matches the cost model applied to the requests.
	total := new(big.Rat)
	for _, r := range res.Requests {
		total.Add(total, new(big.Rat).Add(
			new(big.Rat).Mul(p.PerByte, big.NewRat(r.End-r.Start, 1)), p.Fixed))
	}
	if total.Cmp(res.Cost) != 0 {
		t.Fatalf("trial %d: reported cost %v != recomputed %v", trial, res.Cost, total)
	}
}
