package scheduler

import (
	"math/rand"
	"reflect"
	"testing"
)

func uniformProblem(numPeople, numSlots int, cost int) Problem {
	qualified := make([][]bool, numPeople)
	costs := make([][]int, numPeople)
	for person := range qualified {
		qualified[person] = make([]bool, numSlots)
		costs[person] = make([]int, numSlots)
		for slot := range qualified[person] {
			qualified[person][slot] = true
			costs[person][slot] = cost
		}
	}
	return Problem{NumPeople: numPeople, NumSlots: numSlots, Qualified: qualified, Cost: costs}
}

func TestSolveSingleSlot(t *testing.T) {
	p := uniformProblem(3, 1, 0)
	p.Cost[0][0], p.Cost[1][0], p.Cost[2][0] = 5, 1, 2
	got, ok := Solve(p)
	if !ok {
		t.Fatal("expected feasible")
	}
	want := Schedule{{1, 2}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if c := TotalCost(p, got); c != 3 {
		t.Fatalf("cost %d, want 3", c)
	}
}

func TestSolveInfeasibleTooFewQualified(t *testing.T) {
	p := uniformProblem(3, 2, 0)
	for person := 0; person < 3; person++ {
		p.Qualified[person][1] = person == 0 // slot 1 has a single qualified person
	}
	if _, ok := Solve(p); ok {
		t.Fatal("expected infeasible")
	}
}

func TestSolveInfeasibleAdjacency(t *testing.T) {
	p := uniformProblem(4, 2, 0)
	for person := 0; person < 4; person++ {
		p.Qualified[person][0] = person < 2  // slot 0: people 0,1
		p.Qualified[person][1] = person >= 2 // slot 1: people 2,3
	}
	if _, ok := Solve(p); ok {
		t.Fatal("expected infeasible: no person can bridge the slots")
	}
}

func TestSolveInfeasibleConsecutiveLimit(t *testing.T) {
	// Only two people exist, so both must work every slot; with four
	// slots someone exceeds MaxConsec.
	p := uniformProblem(2, 4, 0)
	if _, ok := Solve(p); ok {
		t.Fatal("expected infeasible: pair cannot cover 4 slots within the consecutive limit")
	}
}

func TestSolveRespectsConsecutiveLimit(t *testing.T) {
	// All costs equal: the lexicographically smallest feasible
	// schedule. Keeping {0,1} for three slots leaves no legal fourth
	// pair (either member would reach a run of four), so the rotation
	// must start one slot earlier.
	p := uniformProblem(3, 4, 0)
	got, ok := Solve(p)
	if !ok {
		t.Fatal("expected feasible")
	}
	want := Schedule{{0, 1}, {0, 1}, {0, 2}, {1, 2}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if err := Check(p, got); err != nil {
		t.Fatalf("solver output failed checker: %v", err)
	}
}

func TestSolvePrefersCheaperRotation(t *testing.T) {
	// People 0,1 are cheap, person 2 is expensive. The optimum still
	// has to buy two expensive slots: keeping {0,1} for three slots
	// would leave no legal fourth pair at all.
	p := uniformProblem(3, 4, 0)
	for slot := 0; slot < 4; slot++ {
		p.Cost[0][slot] = 1
		p.Cost[1][slot] = 1
		p.Cost[2][slot] = 9
	}
	got, ok := Solve(p)
	if !ok {
		t.Fatal("expected feasible")
	}
	if c := TotalCost(p, got); c != 2+2+10+10 {
		t.Fatalf("cost %d, want %d", c, 2+2+10+10)
	}
	want := Schedule{{0, 1}, {0, 1}, {0, 2}, {1, 2}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestSolveLexicographicTieBreak(t *testing.T) {
	// Equal costs everywhere: answer must be the lexicographically
	// smallest pair sequence, not just any optimal one.
	p := uniformProblem(4, 3, 7)
	got, ok := Solve(p)
	if !ok {
		t.Fatal("expected feasible")
	}
	want := Schedule{{0, 1}, {0, 1}, {0, 1}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestSolveInvalidProblem(t *testing.T) {
	if _, ok := Solve(Problem{NumPeople: 1, NumSlots: 1}); ok {
		t.Fatal("expected infeasible for invalid problem")
	}
}

// TestSolveMatchesBruteForce is the exhaustive acceptance check: on
// short random sequences the DP solver must agree with full enumeration
// on feasibility, cost, and the exact tie-broken schedule, and its
// output must pass the constraint checker.
func TestSolveMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for trial := 0; trial < 400; trial++ {
		numPeople := 2 + rng.Intn(4) // 2..5
		numSlots := 1 + rng.Intn(5)  // 1..5
		p := Problem{NumPeople: numPeople, NumSlots: numSlots}
		p.Qualified = make([][]bool, numPeople)
		p.Cost = make([][]int, numPeople)
		for person := 0; person < numPeople; person++ {
			p.Qualified[person] = make([]bool, numSlots)
			p.Cost[person] = make([]int, numSlots)
			for slot := 0; slot < numSlots; slot++ {
				p.Qualified[person][slot] = rng.Float64() < 0.65
				p.Cost[person][slot] = rng.Intn(10)
			}
		}

		gotSched, gotOK := Solve(p)
		wantSched, wantOK := bruteForce(p)
		if gotOK != wantOK {
			t.Fatalf("trial %d: feasibility mismatch: solver=%v brute=%v\n%+v", trial, gotOK, wantOK, p)
		}
		if !gotOK {
			continue
		}
		if !reflect.DeepEqual(gotSched, wantSched) {
			t.Fatalf("trial %d: schedule mismatch:\nsolver %v (cost %d)\nbrute  %v (cost %d)\n%+v",
				trial, gotSched, TotalCost(p, gotSched), wantSched, TotalCost(p, wantSched), p)
		}
		if err := Check(p, gotSched); err != nil {
			t.Fatalf("trial %d: solver output failed checker: %v", trial, err)
		}
	}
}
