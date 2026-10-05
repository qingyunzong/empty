package sched

import (
	"errors"
	"math"
	"math/rand"
	"strings"
	"testing"
)

func jobs(specs ...[4]int64) []Job {
	out := make([]Job, len(specs))
	for i, s := range specs {
		out[i] = Job{ID: string(rune('A' + i)), Proc: s[0], Release: s[1], Due: s[2], Category: int(s[3])}
	}
	return out
}

func TestCycleRejected(t *testing.T) {
	in := &Instance{
		Jobs: jobs([4]int64{1, 0, 10, 0}, [4]int64{1, 0, 10, 0}, [4]int64{1, 0, 10, 0}),
		Prec: [][2]int{{0, 1}, {1, 2}, {2, 0}},
	}
	_, err := in.Solve()
	var ce *CycleError
	if !errors.As(err, &ce) {
		t.Fatalf("expected *CycleError, got %v", err)
	}
	if len(ce.Cycle) != 4 || ce.Cycle[0] != ce.Cycle[3] {
		t.Fatalf("cycle %v is not a closed 3-cycle", ce.Cycle)
	}
	seen := map[int]bool{}
	for _, j := range ce.Cycle[:3] {
		seen[j] = true
	}
	for j := 0; j < 3; j++ {
		if !seen[j] {
			t.Fatalf("cycle %v misses job %d", ce.Cycle, j)
		}
	}
	t.Logf("reported cycle: %s", ce)
}

func TestSelfLoopRejected(t *testing.T) {
	in := &Instance{
		Jobs: jobs([4]int64{1, 0, 10, 0}),
		Prec: [][2]int{{0, 0}},
	}
	var ce *CycleError
	if _, err := in.Solve(); !errors.As(err, &ce) {
		t.Fatalf("expected *CycleError, got %v", err)
	} else if len(ce.Cycle) != 2 || ce.Cycle[0] != 0 || ce.Cycle[1] != 0 {
		t.Fatalf("unexpected self-loop cycle %v", ce.Cycle)
	}
}

func TestCycleRejectedOnLargeInstance(t *testing.T) {
	js := make([]Job, 16)
	for i := range js {
		js[i] = Job{ID: string(rune('A' + i)), Proc: 1, Due: 100}
	}
	in := &Instance{Jobs: js, Prec: [][2]int{{5, 9}, {9, 12}, {12, 5}}}
	var ce *CycleError
	if _, err := in.Solve(); !errors.As(err, &ce) {
		t.Fatalf("expected *CycleError, got %v", err)
	} else if got := ce.Error(); !strings.Contains(got, "F -> J -> M -> F") {
		t.Fatalf("cycle message %q does not name F -> J -> M -> F", got)
	}
}

func TestTooManyJobs(t *testing.T) {
	in := &Instance{Jobs: make([]Job, MaxJobs+1)}
	if _, err := in.Solve(); err == nil {
		t.Fatal("expected error for 17 jobs")
	}
}

func TestKnownOptimum(t *testing.T) {
	// Order B,A gives C=(2,5), Lmax=0, SumC=7; order A,B gives Lmax=1.
	in := &Instance{Jobs: jobs([4]int64{3, 0, 5, 0}, [4]int64{2, 0, 4, 0})}
	sol, err := in.Solve()
	if err != nil {
		t.Fatal(err)
	}
	if sol.MaxLateness != 0 || sol.TotalCompletion != 7 {
		t.Fatalf("got Lmax=%d SumC=%d, want Lmax=0 SumC=7", sol.MaxLateness, sol.TotalCompletion)
	}
	if sol.Order[0] != 1 || sol.Order[1] != 0 {
		t.Fatalf("got order %v, want [1 0]", sol.Order)
	}
	if err := in.Check(sol); err != nil {
		t.Fatal(err)
	}
}

func TestLexicographicTieBreak(t *testing.T) {
	// Both orders give Lmax=-5; A,B has SumC=3+5=8, B,A has 2+5=7.
	in := &Instance{Jobs: jobs([4]int64{3, 0, 10, 0}, [4]int64{2, 0, 10, 0})}
	sol, err := in.Solve()
	if err != nil {
		t.Fatal(err)
	}
	if sol.MaxLateness != -5 || sol.TotalCompletion != 7 {
		t.Fatalf("got Lmax=%d SumC=%d, want Lmax=-5 SumC=7", sol.MaxLateness, sol.TotalCompletion)
	}
}

func TestReleaseAndSetupTimeline(t *testing.T) {
	in := &Instance{
		Jobs: jobs([4]int64{2, 0, 20, 0}, [4]int64{3, 6, 20, 1}),
		Prec: [][2]int{{0, 1}},
		Setup: [][]int64{
			{0, 4},
			{1, 0},
		},
	}
	sol, err := in.Solve()
	if err != nil {
		t.Fatal(err)
	}
	if err := in.Check(sol); err != nil {
		t.Fatal(err)
	}
	tl := sol.Timeline
	// A: [0,2); setup 0->1 during [2,6); B released at 6, runs [6,9).
	if tl[0].Start != 0 || tl[0].End != 2 {
		t.Fatalf("job A placement %+v, want [0,2)", tl[0])
	}
	if tl[1].Setup != 4 || tl[1].SetupStart != 2 || tl[1].Start != 6 || tl[1].End != 9 {
		t.Fatalf("job B placement %+v, want setup [2,6) then [6,9)", tl[1])
	}
	if sol.TotalCompletion != 11 {
		t.Fatalf("SumC=%d, want 11", sol.TotalCompletion)
	}
	out := in.Render(sol)
	for _, want := range []string{"setup  cat 0 -> cat 1", "job    A", "job    B", "Lmax = -11, SumC = 11"} {
		if !strings.Contains(out, want) {
			t.Fatalf("rendered timeline missing %q:\n%s", want, out)
		}
	}
	t.Logf("timeline:\n%s", out)
}

func TestPrecedenceRespected(t *testing.T) {
	in := &Instance{
		Jobs: jobs([4]int64{5, 0, 100, 0}, [4]int64{1, 0, 100, 0}, [4]int64{1, 0, 100, 0}),
		Prec: [][2]int{{2, 1}, {1, 0}},
	}
	sol, err := in.Solve()
	if err != nil {
		t.Fatal(err)
	}
	if err := in.Check(sol); err != nil {
		t.Fatal(err)
	}
	want := []int{2, 1, 0}
	for i, j := range want {
		if sol.Order[i] != j {
			t.Fatalf("got order %v, want %v", sol.Order, want)
		}
	}
}

// bruteForce is an independent enumerator over all n! permutations used to
// cross-check the pruned DFS of solveExhaustive.
func bruteForce(in *Instance) Solution {
	best := Solution{MaxLateness: math.MaxInt64, TotalCompletion: math.MaxInt64}
	perm := make([]int, len(in.Jobs))
	for i := range perm {
		perm[i] = i
	}
	var rec func(k int)
	rec = func(k int) {
		if k == len(perm) {
			if !in.feasibleOrder(perm) {
				return
			}
			if s := in.evaluate(perm); better(s, best) {
				best = s
			}
			return
		}
		for i := k; i < len(perm); i++ {
			perm[k], perm[i] = perm[i], perm[k]
			rec(k + 1)
			perm[k], perm[i] = perm[i], perm[k]
		}
	}
	rec(0)
	return best
}

func randomInstance(r *rand.Rand, n int) *Instance {
	cats := 1 + r.Intn(3)
	in := &Instance{Jobs: make([]Job, n)}
	for i := range in.Jobs {
		in.Jobs[i] = Job{
			ID:       string(rune('A' + i)),
			Proc:     int64(1 + r.Intn(9)),
			Release:  int64(r.Intn(11)),
			Due:      int64(r.Intn(31)),
			Category: r.Intn(cats),
		}
	}
	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			if r.Intn(4) == 0 {
				in.Prec = append(in.Prec, [2]int{i, j})
			}
		}
	}
	if r.Intn(2) == 0 {
		in.Setup = make([][]int64, cats)
		for a := range in.Setup {
			in.Setup[a] = make([]int64, cats)
			for b := range in.Setup[a] {
				if a != b {
					in.Setup[a][b] = int64(r.Intn(5))
				}
			}
		}
	}
	return in
}

func TestExhaustiveMatchesBruteForce(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	for trial := 0; trial < 300; trial++ {
		n := 1 + r.Intn(ExhaustiveLimit)
		in := randomInstance(r, n)
		sol, err := in.Solve()
		if err != nil {
			t.Fatalf("trial %d (n=%d): %v", trial, n, err)
		}
		if err := in.Check(sol); err != nil {
			t.Fatalf("trial %d (n=%d): %v", trial, n, err)
		}
		want := bruteForce(in)
		if sol.MaxLateness != want.MaxLateness || sol.TotalCompletion != want.TotalCompletion {
			t.Fatalf("trial %d (n=%d): got (Lmax=%d, SumC=%d), brute force (Lmax=%d, SumC=%d)",
				trial, n, sol.MaxLateness, sol.TotalCompletion, want.MaxLateness, want.TotalCompletion)
		}
	}
}

func TestHeuristicMatchesExhaustiveOnSmall(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	mismatches := 0
	for trial := 0; trial < 300; trial++ {
		n := 1 + r.Intn(ExhaustiveLimit)
		in := randomInstance(r, n)
		opt := in.solveExhaustive()
		heur := in.solveHeuristic()
		if err := in.Check(heur); err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		if better(heur, opt) {
			t.Fatalf("trial %d: heuristic beat exhaustive optimum", trial)
		}
		if better(opt, heur) {
			mismatches++
		}
	}
	if mismatches > 0 {
		t.Fatalf("heuristic suboptimal on %d/300 small instances", mismatches)
	}
}

func TestLargeInstancesFeasibleAndDeterministic(t *testing.T) {
	r := rand.New(rand.NewSource(99))
	for _, n := range []int{9, 12, 16} {
		in := randomInstance(r, n)
		sol, err := in.Solve()
		if err != nil {
			t.Fatalf("n=%d: %v", n, err)
		}
		if err := in.Check(sol); err != nil {
			t.Fatalf("n=%d: %v", n, err)
		}
		again, err := in.Solve()
		if err != nil {
			t.Fatalf("n=%d: %v", n, err)
		}
		if again.MaxLateness != sol.MaxLateness || again.TotalCompletion != sol.TotalCompletion {
			t.Fatalf("n=%d: non-deterministic result", n)
		}
		// Heuristic must never be worse than its own greedy seed.
		greedy := in.evaluate(in.greedyOrder())
		if better(greedy, sol) {
			t.Fatalf("n=%d: local search degraded the greedy seed", n)
		}
	}
}
