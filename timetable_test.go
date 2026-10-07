package timetable

import (
	"math"
	"math/rand"
	"reflect"
	"strings"
	"testing"
)

// referenceSolve is an independent naive reference: it walks the full
// Cartesian product of the raw domains, computes the total penalty of
// every complete assignment from scratch via the exported WaitingTime,
// and keeps the best (penalty, then lexicographic) vector.
func referenceSolve(t *testing.T, p Problem) Solution {
	t.Helper()
	best := Solution{Penalty: math.MaxInt}
	current := make([]int, len(p.Lines))
	var walk func(line int)
	walk = func(line int) {
		if line == len(p.Lines) {
			penalty := 0
			for _, tr := range p.Transfers {
				wait := WaitingTime(current[tr.From], current[tr.To], p.Period)
				if wait > tr.Threshold {
					penalty += tr.Weight * (wait - tr.Threshold)
				}
			}
			if penalty < best.Penalty || (penalty == best.Penalty && lexLess(current, best.Offsets)) {
				best.Penalty = penalty
				best.Offsets = append([]int(nil), current...)
			}
			return
		}
		for _, off := range p.Lines[line].Domain {
			current[line] = off
			walk(line + 1)
		}
	}
	walk(0)
	return best
}

func lexLess(a, b []int) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

func TestWaitingTimeCyclic(t *testing.T) {
	cases := []struct {
		from, to, period, want int
	}{
		{1, 3, 10, 2},
		{8, 2, 10, 4}, // wraps around midnight boundary
		{4, 4, 10, 0}, // same-time transfer: wait 0
		{0, 0, 7, 0},  // same-time at period origin
		{9, 0, 10, 1}, // one minute after wrap
		{5, 5, 1, 0},  // degenerate period 1
	}
	for _, c := range cases {
		if got := WaitingTime(c.from, c.to, c.period); got != c.want {
			t.Errorf("WaitingTime(%d, %d, %d) = %d, want %d", c.from, c.to, c.period, got, c.want)
		}
	}
}

func TestSolveHandComputed(t *testing.T) {
	// Period 10. Line0 domain {1,2}, line1 domain {3,4}.
	// Transfer 0->1, threshold 1, weight 5.
	//   (1,3): wait 2 -> 5*(2-1)=5
	//   (1,4): wait 3 -> 10
	//   (2,3): wait 1 -> 0   <- optimum
	//   (2,4): wait 2 -> 5
	p := Problem{
		Period: 10,
		Lines: []Line{
			{Domain: []int{1, 2}},
			{Domain: []int{3, 4}},
		},
		Transfers: []Transfer{{From: 0, To: 1, Threshold: 1, Weight: 5}},
	}
	got, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	want := Solution{Offsets: []int{2, 3}, Penalty: 0}
	if got.Penalty != want.Penalty || !reflect.DeepEqual(got.Offsets, want.Offsets) {
		t.Fatalf("Solve = %+v, want %+v", got, want)
	}
}

func TestSolveSameTimeTransferFeasible(t *testing.T) {
	// Threshold 0: only a simultaneous departure avoids the penalty.
	// Same-time transfer must be treated as feasible (wait 0, no penalty).
	p := Problem{
		Period: 10,
		Lines: []Line{
			{Domain: []int{4}},
			{Domain: []int{4, 5}},
		},
		Transfers: []Transfer{{From: 0, To: 1, Threshold: 0, Weight: 7}},
	}
	got, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if got.Penalty != 0 || !reflect.DeepEqual(got.Offsets, []int{4, 4}) {
		t.Fatalf("Solve = %+v, want offsets [4 4] penalty 0 (same-time transfer)", got)
	}
}

func TestSolveTieBreakLexicographic(t *testing.T) {
	// No transfers: every assignment has penalty 0, so the answer must be
	// the lexicographically smallest vector, i.e. each domain's minimum.
	p := Problem{
		Period: 6,
		Lines: []Line{
			{Domain: []int{3, 1, 2}},
			{Domain: []int{5, 0}},
			{Domain: []int{4}},
		},
	}
	got, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if got.Penalty != 0 || !reflect.DeepEqual(got.Offsets, []int{1, 0, 4}) {
		t.Fatalf("Solve = %+v, want offsets [1 0 4] penalty 0", got)
	}
}

func TestSolveWrapAroundOptimum(t *testing.T) {
	// The optimum exploits the cyclic wrap: departing line1 at 0 gives
	// wait (0-9) mod 10 = 1, under the threshold.
	p := Problem{
		Period: 10,
		Lines: []Line{
			{Domain: []int{9}},
			{Domain: []int{0, 5}},
		},
		Transfers: []Transfer{{From: 0, To: 1, Threshold: 2, Weight: 3}},
	}
	got, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if got.Penalty != 0 || !reflect.DeepEqual(got.Offsets, []int{9, 0}) {
		t.Fatalf("Solve = %+v, want offsets [9 0] penalty 0", got)
	}
}

func TestSolveMaxSizeZeroPenaltyPrunes(t *testing.T) {
	// Maximum instance: 8 lines x 12 offsets. A chain of transfers with
	// generous thresholds keeps a zero-penalty assignment reachable, so
	// the solver must terminate quickly via pruning.
	p := Problem{Period: 12}
	for i := 0; i < MaxLines; i++ {
		domain := make([]int, MaxDomainSize)
		for v := range domain {
			domain[v] = v
		}
		p.Lines = append(p.Lines, Line{Domain: domain})
	}
	for i := 0; i+1 < MaxLines; i++ {
		p.Transfers = append(p.Transfers, Transfer{From: i, To: i + 1, Threshold: 11, Weight: 2})
	}
	got, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if got.Penalty != 0 {
		t.Fatalf("Solve penalty = %d, want 0", got.Penalty)
	}
	if !reflect.DeepEqual(got.Offsets, make([]int, MaxLines)) {
		t.Fatalf("Solve offsets = %v, want all zeros (lexicographic minimum)", got.Offsets)
	}
}

func TestSolveMatchesReferenceRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(20261007))
	for trial := 0; trial < 300; trial++ {
		period := 1 + rng.Intn(12)
		numLines := 1 + rng.Intn(5)
		p := Problem{Period: period}
		for i := 0; i < numLines; i++ {
			size := 1 + rng.Intn(6)
			domain := make([]int, 0, size)
			for len(domain) < size {
				domain = append(domain, rng.Intn(period))
			}
			p.Lines = append(p.Lines, Line{Domain: domain})
		}
		numTransfers := rng.Intn(7)
		for i := 0; i < numTransfers; i++ {
			p.Transfers = append(p.Transfers, Transfer{
				From:      rng.Intn(numLines),
				To:        rng.Intn(numLines),
				Threshold: rng.Intn(period),
				Weight:    rng.Intn(6),
			})
		}
		got, err := Solve(p)
		if err != nil {
			t.Fatalf("trial %d: Solve: %v", trial, err)
		}
		want := referenceSolve(t, p)
		if got.Penalty != want.Penalty || !reflect.DeepEqual(got.Offsets, want.Offsets) {
			t.Fatalf("trial %d: Solve = %+v, reference = %+v, problem = %+v", trial, got, want, p)
		}
		// Cross-check the reported penalty through the exported evaluator.
		pen, err := Evaluate(p, got.Offsets)
		if err != nil {
			t.Fatalf("trial %d: Evaluate: %v", trial, err)
		}
		if pen != got.Penalty {
			t.Fatalf("trial %d: Evaluate = %d, Solve reported %d", trial, pen, got.Penalty)
		}
	}
}

func TestValidateErrors(t *testing.T) {
	valid := Problem{
		Period:    10,
		Lines:     []Line{{Domain: []int{0, 1}}},
		Transfers: []Transfer{{From: 0, To: 0, Threshold: 0, Weight: 1}},
	}
	cases := []struct {
		name    string
		mutate  func(p *Problem)
		wantErr string
	}{
		{"period zero", func(p *Problem) { p.Period = 0 }, "period"},
		{"no lines", func(p *Problem) { p.Lines = nil }, "at least one line"},
		{"too many lines", func(p *Problem) {
			p.Lines = make([]Line, MaxLines+1)
			for i := range p.Lines {
				p.Lines[i] = Line{Domain: []int{0}}
			}
		}, "at most"},
		{"empty domain", func(p *Problem) { p.Lines[0].Domain = nil }, "empty domain"},
		{"domain too large", func(p *Problem) {
			p.Lines[0].Domain = make([]int, MaxDomainSize+1)
		}, "max"},
		{"offset out of range", func(p *Problem) { p.Lines[0].Domain = []int{10} }, "outside"},
		{"negative offset", func(p *Problem) { p.Lines[0].Domain = []int{-1} }, "outside"},
		{"transfer line out of range", func(p *Problem) { p.Transfers[0].To = 1 }, "outside"},
		{"negative threshold", func(p *Problem) { p.Transfers[0].Threshold = -1 }, "threshold"},
		{"negative weight", func(p *Problem) { p.Transfers[0].Weight = -1 }, "weight"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := valid
			p.Lines = append([]Line(nil), valid.Lines...)
			p.Transfers = append([]Transfer(nil), valid.Transfers...)
			c.mutate(&p)
			if _, err := Solve(p); err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("Solve error = %v, want substring %q", err, c.wantErr)
			}
		})
	}
}

func TestEvaluateRejectsBadAssignment(t *testing.T) {
	p := Problem{
		Period: 5,
		Lines:  []Line{{Domain: []int{0, 2}}, {Domain: []int{1}}},
	}
	if _, err := Evaluate(p, []int{0}); err == nil {
		t.Fatal("Evaluate accepted wrong-length assignment")
	}
	if _, err := Evaluate(p, []int{1, 1}); err == nil {
		t.Fatal("Evaluate accepted offset outside domain")
	}
	pen, err := Evaluate(p, []int{2, 1})
	if err != nil || pen != 0 {
		t.Fatalf("Evaluate = %d, %v; want 0, nil", pen, err)
	}
}
