package sched

import (
	"errors"
	"math/rand"
	"strings"
	"testing"
)

// bruteForce is an independent test oracle: it enumerates all n!
// permutations, keeps precedence-feasible ones, and returns the best
// lexicographic (Lmax, SumC) pair.
func bruteForce(t *testing.T, in *Instance) (int, int) {
	t.Helper()
	n := len(in.Jobs)
	idx := map[string]int{}
	for i, j := range in.Jobs {
		idx[j.ID] = i
	}
	bestL, bestS := 1<<60, 1<<60
	perm := make([]int, n)
	for i := range perm {
		perm[i] = i
	}
	var rec func(k int)
	rec = func(k int) {
		if k == n {
			// Check precedence: every predecessor must appear earlier.
			pos := make([]int, n)
			for i, j := range perm {
				pos[j] = i
			}
			for i, j := range in.Jobs {
				for _, pre := range j.Pred {
					if pos[idx[pre]] > pos[i] {
						return
					}
				}
			}
			now, prev, lmax, sumC := 0, -1, -1<<60, 0
			for _, j := range perm {
				job := in.Jobs[j]
				start := now
				if prev >= 0 {
					start += in.Setups[in.Jobs[prev].Class][job.Class]
				}
				if job.Rel > start {
					start = job.Rel
				}
				end := start + job.Proc
				if l := end - job.Due; l > lmax {
					lmax = l
				}
				sumC += end
				now, prev = end, j
			}
			if lmax < bestL || (lmax == bestL && sumC < bestS) {
				bestL, bestS = lmax, sumC
			}
			return
		}
		for i := k; i < n; i++ {
			perm[k], perm[i] = perm[i], perm[k]
			rec(k + 1)
			perm[k], perm[i] = perm[i], perm[k]
		}
	}
	rec(0)
	return bestL, bestS
}

func TestValidateRejectsBadInstances(t *testing.T) {
	cases := []struct {
		name string
		in   Instance
	}{
		{"empty", Instance{}},
		{"too many jobs", Instance{Jobs: make([]Job, MaxJobs+1)}},
		{"duplicate ID", Instance{Jobs: []Job{{ID: "A", Proc: 1}, {ID: "A", Proc: 1}}}},
		{"empty ID", Instance{Jobs: []Job{{Proc: 1}}}},
		{"zero proc", Instance{Jobs: []Job{{ID: "A"}}}},
		{"negative release", Instance{Jobs: []Job{{ID: "A", Proc: 1, Rel: -1}}}},
		{"negative class", Instance{Jobs: []Job{{ID: "A", Proc: 1, Class: -1}}}},
		{"missing setup row", Instance{Jobs: []Job{{ID: "A", Proc: 1, Class: 2}}, Setups: [][]int{{0, 0, 0}}}},
		{"short setup row", Instance{Jobs: []Job{{ID: "A", Proc: 1, Class: 1}}, Setups: [][]int{{0, 0}, {0}}}},
		{"negative setup", Instance{Jobs: []Job{{ID: "A", Proc: 1, Class: 1}}, Setups: [][]int{{0, -1}, {0, 0}}}},
		{"unknown predecessor", Instance{Jobs: []Job{{ID: "A", Proc: 1, Pred: []string{"B"}}}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.in.Validate(); err == nil {
				t.Fatalf("expected validation error, got nil")
			}
		})
	}
}

func TestCycleDetection(t *testing.T) {
	in := &Instance{Jobs: []Job{
		{ID: "A", Proc: 1, Pred: []string{"C"}},
		{ID: "B", Proc: 1, Pred: []string{"A"}},
		{ID: "C", Proc: 1, Pred: []string{"B"}},
		{ID: "D", Proc: 1},
	}}
	_, err := Solve(in)
	var ce *CycleError
	if !errors.As(err, &ce) {
		t.Fatalf("expected CycleError, got %v", err)
	}
	if len(ce.Cycle) < 2 || ce.Cycle[0] != ce.Cycle[len(ce.Cycle)-1] {
		t.Fatalf("cycle must start and end with the same job, got %v", ce.Cycle)
	}
	// Every consecutive pair must be a real precedence edge: the cycle
	// reads along the "job -> its predecessor" direction.
	pred := map[string]map[string]bool{}
	for _, j := range in.Jobs {
		pred[j.ID] = map[string]bool{}
		for _, p := range j.Pred {
			pred[j.ID][p] = true
		}
	}
	for i := 0; i+1 < len(ce.Cycle); i++ {
		from, to := ce.Cycle[i], ce.Cycle[i+1]
		if !pred[from][to] {
			t.Fatalf("reported cycle edge %s -> %s is not a precedence edge", from, to)
		}
	}
	if got := err.Error(); !strings.Contains(got, "cycle") {
		t.Fatalf("error message should mention the cycle: %q", got)
	}
}

func TestSelfLoopIsCycle(t *testing.T) {
	in := &Instance{Jobs: []Job{{ID: "A", Proc: 1, Pred: []string{"A"}}}}
	var ce *CycleError
	if !errors.As(in.Validate(), &ce) {
		t.Fatalf("expected CycleError for self loop")
	}
	if len(ce.Cycle) != 2 || ce.Cycle[0] != "A" || ce.Cycle[1] != "A" {
		t.Fatalf("unexpected self-loop cycle %v", ce.Cycle)
	}
}

func TestExactSolveHandComputed(t *testing.T) {
	// Orders (J1 before J3):
	//  J1,J2,J3: Lmax=3 SumC=19 | J1,J3,J2: Lmax=4 SumC=15 | J2,J1,J3: Lmax=1 SumC=15
	in := &Instance{
		Jobs: []Job{
			{ID: "J1", Proc: 3, Due: 5, Class: 0},
			{ID: "J2", Proc: 2, Due: 4, Class: 1},
			{ID: "J3", Proc: 1, Due: 10, Class: 0, Pred: []string{"J1"}},
		},
		Setups: [][]int{{0, 2}, {1, 0}},
	}
	sc, err := Solve(in)
	if err != nil {
		t.Fatal(err)
	}
	if !sc.Exact {
		t.Fatal("expected exact solve for 3 jobs")
	}
	if sc.Lmax != 1 || sc.SumC != 15 {
		t.Fatalf("got Lmax=%d SumC=%d, want Lmax=1 SumC=15", sc.Lmax, sc.SumC)
	}
	wantOrder := []string{"J2", "J1", "J3"}
	for i, task := range sc.Tasks {
		if task.JobID != wantOrder[i] {
			t.Fatalf("task %d = %s, want %s", i, task.JobID, wantOrder[i])
		}
	}
	// J1 follows J2: setup 1->0 = 1, so J1 starts at 2+1=3.
	if sc.Tasks[1].Setup != 1 || sc.Tasks[1].Start != 3 {
		t.Fatalf("J1 task = %+v, want setup=1 start=3", sc.Tasks[1])
	}
	if err := in.Verify(sc); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestLmaxBeatsSumC(t *testing.T) {
	// J1,J2: Lmax=6 SumC=12 | J2,J1: Lmax=5 SumC=21 -> Lmax wins.
	in := &Instance{
		Jobs:   []Job{{ID: "J1", Proc: 1, Due: 100}, {ID: "J2", Proc: 10, Due: 5}},
		Setups: [][]int{{0}},
	}
	sc, err := Solve(in)
	if err != nil {
		t.Fatal(err)
	}
	if sc.Lmax != 5 || sc.SumC != 21 {
		t.Fatalf("got Lmax=%d SumC=%d, want Lmax=5 SumC=21", sc.Lmax, sc.SumC)
	}
	if sc.Tasks[0].JobID != "J2" {
		t.Fatalf("first task = %s, want J2", sc.Tasks[0].JobID)
	}
}

func TestReleaseTimeCreatesIdleGap(t *testing.T) {
	in := &Instance{
		Jobs:   []Job{{ID: "A", Proc: 2, Rel: 10, Due: 20}},
		Setups: [][]int{{0}},
	}
	sc, err := Solve(in)
	if err != nil {
		t.Fatal(err)
	}
	if sc.Tasks[0].Start != 10 || sc.Tasks[0].End != 12 {
		t.Fatalf("task = %+v, want start=10 end=12", sc.Tasks[0])
	}
}

func TestExactMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 60; trial++ {
		n := 2 + rng.Intn(6) // 2..7 jobs
		classes := 1 + rng.Intn(3)
		in := &Instance{Setups: make([][]int, classes)}
		for c := range in.Setups {
			in.Setups[c] = make([]int, classes)
			for d := range in.Setups[c] {
				if c != d {
					in.Setups[c][d] = rng.Intn(4)
				}
			}
		}
		for i := 0; i < n; i++ {
			j := Job{
				ID:    string(rune('A' + i)),
				Proc:  1 + rng.Intn(6),
				Rel:   rng.Intn(8),
				Due:   rng.Intn(30),
				Class: rng.Intn(classes),
			}
			// Random predecessors among earlier jobs keep the graph acyclic.
			for k := 0; k < i; k++ {
				if rng.Intn(3) == 0 {
					j.Pred = append(j.Pred, string(rune('A'+k)))
				}
			}
			in.Jobs = append(in.Jobs, j)
		}
		sc, err := Solve(in)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		if !sc.Exact {
			t.Fatalf("trial %d: n=%d should be exact", trial, n)
		}
		wantL, wantS := bruteForce(t, in)
		if sc.Lmax != wantL || sc.SumC != wantS {
			t.Fatalf("trial %d: got (Lmax=%d SumC=%d), brute force (Lmax=%d SumC=%d)",
				trial, sc.Lmax, sc.SumC, wantL, wantS)
		}
		if err := in.Verify(sc); err != nil {
			t.Fatalf("trial %d: Verify: %v", trial, err)
		}
	}
}

func TestBeamSearchSixteenJobsFeasible(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	in := &Instance{Setups: [][]int{{0, 3, 1}, {2, 0, 2}, {1, 1, 0}}}
	for i := 0; i < MaxJobs; i++ {
		j := Job{
			ID:    string(rune('A' + i)),
			Proc:  1 + rng.Intn(9),
			Rel:   rng.Intn(15),
			Due:   20 + rng.Intn(80),
			Class: rng.Intn(3),
		}
		for k := 0; k < i; k++ {
			if rng.Intn(4) == 0 {
				j.Pred = append(j.Pred, string(rune('A'+k)))
			}
		}
		in.Jobs = append(in.Jobs, j)
	}
	sc, err := Solve(in)
	if err != nil {
		t.Fatal(err)
	}
	if sc.Exact {
		t.Fatal("16 jobs should use the heuristic")
	}
	if len(sc.Tasks) != MaxJobs {
		t.Fatalf("got %d tasks, want %d", len(sc.Tasks), MaxJobs)
	}
	if err := in.Verify(sc); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestVerifyRejectsTamperedSchedule(t *testing.T) {
	in := &Instance{
		Jobs:   []Job{{ID: "A", Proc: 2, Due: 10}, {ID: "B", Proc: 2, Due: 10, Pred: []string{"A"}}},
		Setups: [][]int{{0}},
	}
	sc, err := Solve(in)
	if err != nil {
		t.Fatal(err)
	}
	bad := *sc
	bad.Tasks = append([]Task(nil), sc.Tasks...)
	bad.Tasks[0], bad.Tasks[1] = bad.Tasks[1], bad.Tasks[0] // violates precedence
	if err := in.Verify(&bad); err == nil {
		t.Fatal("expected Verify to reject precedence violation")
	}
	bad2 := *sc
	bad2.SumC++
	if err := in.Verify(&bad2); err == nil {
		t.Fatal("expected Verify to reject wrong objective")
	}
}

func TestRenderTimeline(t *testing.T) {
	in := &Instance{
		Jobs: []Job{
			{ID: "J1", Proc: 3, Due: 5, Class: 0},
			{ID: "J2", Proc: 2, Due: 4, Class: 1},
		},
		Setups: [][]int{{0, 2}, {1, 0}},
	}
	sc, err := Solve(in)
	if err != nil {
		t.Fatal(err)
	}
	out := sc.Render()
	for _, want := range []string{"exact", "J1", "J2", "Lmax=", "SumC=", "setup="} {
		if !strings.Contains(out, want) {
			t.Fatalf("timeline missing %q:\n%s", want, out)
		}
	}
	t.Logf("\n%s", out)
}
