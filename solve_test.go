package main

import (
	"math/rand"
	"strings"
	"testing"
)

// decreasingCost builds a non-increasing cost table of length cycle+1.
func decreasingCost(r *rand.Rand, cycle, start, maxDrop int) []int {
	c := make([]int, cycle+1)
	c[0] = start
	for g := 1; g <= cycle; g++ {
		drop := r.Intn(maxDrop + 1)
		c[g] = c[g-1] - drop
		if c[g] < 0 {
			c[g] = 0
		}
	}
	return c
}

// randomInstance builds a random tiny instance; feasibility is not guaranteed.
func randomInstance(r *rand.Rand) *Instance {
	n := 2 + r.Intn(4)     // 2..5 phases
	cycle := 4 + r.Intn(5) // 4..8 slots
	inst := &Instance{Cycle: cycle}
	for i := 0; i < n; i++ {
		inst.Phases = append(inst.Phases, Phase{
			Name: string(rune('A' + i)),
			Min:  r.Intn(3), // 0..2
			Cost: decreasingCost(r, cycle, 20+r.Intn(60), 15),
		})
	}
	for a := 0; a < n; a++ {
		for b := a + 1; b < n; b++ {
			if r.Float64() < 0.5 {
				inst.Conflicts = append(inst.Conflicts, [2]int{a, b})
			}
		}
	}
	return inst
}

// TestSolveMatchesBruteForce is the core cross-check: on tiny cycles the
// branch-and-bound optimum must equal the exhaustive enumeration optimum,
// including agreement on infeasibility.
func TestSolveMatchesBruteForce(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for trial := 0; trial < 200; trial++ {
		inst := randomInstance(r)
		alloc, slots, total, ok := Solve(inst)
		best, bruteTotal, _, _, bruteOK := BruteForce(inst)
		if ok != bruteOK {
			t.Fatalf("trial %d: feasibility mismatch solve=%v brute=%v inst=%+v", trial, ok, bruteOK, inst)
		}
		if !ok {
			continue
		}
		if total != bruteTotal {
			t.Fatalf("trial %d: optimum mismatch solve=%d brute=%d alloc=%v best=%v inst=%+v",
				trial, total, bruteTotal, alloc, best, inst)
		}
		if _, err := BuildCertificate(inst, alloc, slots); err != nil {
			t.Fatalf("trial %d: certificate invalid: %v", trial, err)
		}
	}
}

func TestHandcraftedOptimum(t *testing.T) {
	// Two conflicting phases, cycle 4. Costs: A: 10,7,5,4,4 ; B: 9,6,4,3,3.
	// gA+gB <= 4. Best split: gA=2 (5) + gB=2 (4) = 9? Check gA=1,gB=3: 7+3=10;
	// gA=3,gB=1: 4+6=10; gA=2,gB=2: 5+4=9. Optimum 9.
	inst := &Instance{
		Cycle: 4,
		Phases: []Phase{
			{Name: "A", Min: 1, Cost: []int{10, 7, 5, 4, 4}},
			{Name: "B", Min: 1, Cost: []int{9, 6, 4, 3, 3}},
		},
		Conflicts: [][2]int{{0, 1}},
	}
	_, _, total, ok := Solve(inst)
	if !ok || total != 9 {
		t.Fatalf("got total=%d ok=%v, want 9", total, ok)
	}
	if _, bruteTotal, _, _, _ := BruteForce(inst); bruteTotal != 9 {
		t.Fatalf("brute force got %d, want 9", bruteTotal)
	}
}

func TestInfeasible(t *testing.T) {
	inst := &Instance{
		Cycle: 3,
		Phases: []Phase{
			{Name: "A", Min: 2, Cost: []int{5, 4, 3, 2}},
			{Name: "B", Min: 2, Cost: []int{5, 4, 3, 2}},
		},
		Conflicts: [][2]int{{0, 1}},
	}
	if _, _, _, ok := Solve(inst); ok {
		t.Fatal("expected infeasible from Solve")
	}
	if _, _, _, _, ok := BruteForce(inst); ok {
		t.Fatal("expected infeasible from BruteForce")
	}
}

func TestFlatCostExtension(t *testing.T) {
	inst := &Instance{
		Cycle: 6,
		Phases: []Phase{
			{Name: "A", Min: 0, Cost: []int{8, 3, 1}}, // extends flat: cost[g>=2]=1
		},
	}
	if got := inst.CostOf(0, 5); got != 1 {
		t.Fatalf("CostOf(0,5)=%d, want 1", got)
	}
	alloc, slots, total, ok := Solve(inst)
	if !ok {
		t.Fatal("expected feasible")
	}
	if total != 1 || alloc[0] < 2 {
		t.Fatalf("got total=%d alloc=%v, want total=1", total, alloc)
	}
	if _, err := BuildCertificate(inst, alloc, slots); err != nil {
		t.Fatal(err)
	}
}

func TestNonMonotoneCost(t *testing.T) {
	// Cost dips at g=2 then rises; optimizer must not assume monotonicity.
	inst := &Instance{
		Cycle: 5,
		Phases: []Phase{
			{Name: "A", Min: 0, Cost: []int{9, 9, 1, 9, 9, 9}},
			{Name: "B", Min: 0, Cost: []int{9, 9, 1, 9, 9, 9}},
		},
		Conflicts: [][2]int{{0, 1}},
	}
	_, _, total, ok := Solve(inst)
	if !ok || total != 2 {
		t.Fatalf("got total=%d ok=%v, want 2", total, ok)
	}
	if _, bruteTotal, _, _, _ := BruteForce(inst); bruteTotal != total {
		t.Fatalf("brute=%d solve=%d", bruteTotal, total)
	}
}

func TestValidation(t *testing.T) {
	bad := []string{
		`{"cycle": 61, "phases": [{"name":"A","min":0,"cost":[1]}]}`,
		`{"cycle": 4, "phases": []}`,
		`{"cycle": 4, "phases": [{"name":"A","min":5,"cost":[1]}]}`,
		`{"cycle": 4, "phases": [{"name":"A","min":0,"cost":[]}]}`,
		`{"cycle": 4, "phases": [{"name":"A","min":0,"cost":[1]}], "conflicts": [[0,1]]}`,
		`{"cycle": 4, "phases": [{"name":"A","min":0,"cost":[1]}], "conflicts": [[0,0]]}`,
	}
	for _, s := range bad {
		if _, err := LoadInstance(strings.NewReader(s)); err == nil {
			t.Fatalf("expected error for %s", s)
		}
	}
}

func TestNonPerfectGraph(t *testing.T) {
	// C5 conflict graph, cycle 2, every phase needs 1 slot. All clique
	// constraints (edges) allow 2 slots, but chi(C5)=3, so no schedule
	// exists. Both solver and brute force must report infeasible.
	inst := &Instance{Cycle: 2}
	for i := 0; i < 5; i++ {
		inst.Phases = append(inst.Phases, Phase{
			Name: string(rune('A' + i)), Min: 1, Cost: []int{5, 1, 0},
		})
		inst.Conflicts = append(inst.Conflicts, [2]int{i, (i + 1) % 5})
	}
	if _, _, _, ok := Solve(inst); ok {
		t.Fatal("Solve should report infeasible for C5 with cycle 2")
	}
	if _, _, _, _, ok := BruteForce(inst); ok {
		t.Fatal("BruteForce should report infeasible for C5 with cycle 2")
	}
	// With cycle 3 it becomes feasible.
	inst.Cycle = 3
	alloc, slots, _, ok := Solve(inst)
	if !ok {
		t.Fatal("Solve should find a plan for C5 with cycle 3")
	}
	if _, err := BuildCertificate(inst, alloc, slots); err != nil {
		t.Fatal(err)
	}
}

func TestSolveMatchesBruteForceLarger(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	for trial := 0; trial < 60; trial++ {
		inst := randomInstance(r)
		inst.Cycle = 8 + r.Intn(5) // 8..12
		for i := range inst.Phases {
			inst.Phases[i].Cost = decreasingCost(r, inst.Cycle, 20+r.Intn(60), 15)
		}
		_, _, total, ok := Solve(inst)
		_, bruteTotal, _, _, bruteOK := BruteForce(inst)
		if ok != bruteOK || (ok && total != bruteTotal) {
			t.Fatalf("trial %d: solve=(%d,%v) brute=(%d,%v)", trial, total, ok, bruteTotal, bruteOK)
		}
	}
}

func TestCLIEndToEnd(t *testing.T) {
	in := `{"cycle": 6, "phases": [
		{"name":"A","min":1,"cost":[20,10,5,2,1,0,0]},
		{"name":"B","min":1,"cost":[18,9,4,2,1,0,0]}],
		"conflicts": [[0,1]]}`
	var out strings.Builder
	if err := run([]string{"-verify"}, strings.NewReader(in), &out); err != nil {
		t.Fatal(err)
	}
	s := out.String()
	for _, want := range []string{"CYCLE 6", "SLOTS", "TOTAL=", "CHECK ok", "EXHAUSTIVE match"} {
		if !strings.Contains(s, want) {
			t.Fatalf("output missing %q:\n%s", want, s)
		}
	}
}

func TestCLIMismatchDetection(t *testing.T) {
	// An infeasible instance must make the CLI fail cleanly.
	in := `{"cycle": 2, "phases": [
		{"name":"A","min":2,"cost":[1,1,1]},
		{"name":"B","min":2,"cost":[1,1,1]}],
		"conflicts": [[0,1]]}`
	var out strings.Builder
	if err := run(nil, strings.NewReader(in), &out); err == nil {
		t.Fatal("expected infeasible error")
	}
}
