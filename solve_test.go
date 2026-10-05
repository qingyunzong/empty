package main

import (
	"math/rand"
	"testing"
)

func mustSolve(t *testing.T, p *Problem) Solution {
	t.Helper()
	sol, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	return sol
}

func startsOf(sol Solution, n int) []int {
	s := make([]int, n)
	for _, a := range sol.Assignments {
		s[a.ShipIndex] = a.Start
	}
	return s
}

func TestMidnightCrossing(t *testing.T) {
	p := &Problem{
		BerthLength: 100,
		Step:        30,
		Tides:       []Window{{Start: 1320, End: 1560}}, // 22:00 .. 02:00 next day
		Ships:       []Ship{{ID: "owl", Length: 100, Arrival: 1380, Duration: 180}},
	}
	sol := mustSolve(t, p)
	a := sol.Assignments[0]
	if a.Start != 1380 || a.End != 1560 {
		t.Fatalf("got [%d,%d), want [1380,1560)", a.Start, a.End)
	}
	if a.End <= 1440 {
		t.Fatal("expected occupancy to cross midnight")
	}
	if sol.TotalWait != 0 {
		t.Fatalf("total wait = %d, want 0", sol.TotalWait)
	}
}

func TestBerthLengthAllowsParallel(t *testing.T) {
	base := Problem{
		Step:  30,
		Tides: []Window{{0, 600}},
		Ships: []Ship{
			{ID: "a", Length: 100, Arrival: 60, Duration: 120},
			{ID: "b", Length: 100, Arrival: 90, Duration: 120},
		},
	}
	wide := base
	wide.BerthLength = 200
	sol := mustSolve(t, &wide)
	if sol.TotalWait != 0 {
		t.Fatalf("two 100m ships on a 200m berth should both start on arrival, wait=%d", sol.TotalWait)
	}
	narrow := base
	narrow.BerthLength = 150
	sol = mustSolve(t, &narrow)
	if sol.TotalWait == 0 {
		t.Fatal("150m berth cannot hold both ships; some waiting is required")
	}
	st := startsOf(sol, 2)
	if !narrow.feasible(st) {
		t.Fatalf("solver returned infeasible starts %v", st)
	}
}

func TestKnownOptimum(t *testing.T) {
	// Single-ship berth (capacity 100, all ships 100m): three ships,
	// 60-minute jobs, arrivals 0/10/20. Optimal serves in arrival order:
	// waits 0 + 50 + 100 = 150.
	p := &Problem{
		BerthLength: 100,
		Step:        10,
		Tides:       []Window{{0, 600}},
		Ships: []Ship{
			{ID: "a", Length: 100, Arrival: 0, Duration: 60},
			{ID: "b", Length: 100, Arrival: 10, Duration: 60},
			{ID: "c", Length: 100, Arrival: 20, Duration: 60},
		},
	}
	sol := mustSolve(t, p)
	if sol.TotalWait != 150 {
		t.Fatalf("total wait = %d, want 150", sol.TotalWait)
	}
	if sol.Makespan != 180 {
		t.Fatalf("makespan = %d, want 180", sol.Makespan)
	}
}

func TestNoFeasibleSchedule(t *testing.T) {
	p := &Problem{
		BerthLength: 100,
		Step:        30,
		Tides:       []Window{{0, 120}},
		Ships:       []Ship{{ID: "long", Length: 50, Arrival: 0, Duration: 180}},
	}
	if _, err := Solve(p); err == nil {
		t.Fatal("expected error: service longer than any tidal window")
	}
}

// TestMaxScaleSolves checks that a 12-ship instance (the supported maximum)
// solves quickly and feasibly.
func TestMaxScaleSolves(t *testing.T) {
	p := &Problem{
		BerthLength: 200,
		Step:        30,
		Tides:       []Window{{0, 1440}, {1560, 2880}},
	}
	for i := 0; i < MaxShips; i++ {
		p.Ships = append(p.Ships, Ship{
			ID:       string(rune('a' + i)),
			Length:   40 + 10*i,
			Arrival:  60 * i,
			Duration: 60 + 30*(i%3),
		})
	}
	sol := mustSolve(t, p)
	st := startsOf(sol, len(p.Ships))
	if !p.feasible(st) {
		t.Fatalf("infeasible 12-ship schedule: %v", st)
	}
}

// TestSolveMatchesBruteForce cross-checks the branch-and-bound solver
// against full enumeration on deterministic and randomized small instances.
func TestSolveMatchesBruteForce(t *testing.T) {
	fixed := []Problem{
		{
			BerthLength: 200, Step: 30,
			Tides: []Window{{1080, 1620}, {1860, 2160}},
			Ships: []Ship{
				{ID: "Aurora", Length: 120, Arrival: 1110, Duration: 120},
				{ID: "Boreal", Length: 90, Arrival: 1140, Duration: 90},
				{ID: "Cygnus", Length: 150, Arrival: 1230, Duration: 150},
				{ID: "Dorado", Length: 60, Arrival: 1300, Duration: 60},
				{ID: "Eridani", Length: 200, Arrival: 1830, Duration: 180},
			},
		},
		{
			BerthLength: 100, Step: 15,
			Tides: []Window{{0, 300}},
			Ships: []Ship{
				{ID: "a", Length: 60, Arrival: 0, Duration: 45},
				{ID: "b", Length: 60, Arrival: 15, Duration: 60},
				{ID: "c", Length: 40, Arrival: 30, Duration: 30},
			},
		},
	}
	for i := range fixed {
		checkAgainstBruteForce(t, &fixed[i])
	}

	rng := rand.New(rand.NewSource(20261006))
	for trial := 0; trial < 150; trial++ {
		p := randomProblem(rng)
		if p == nil {
			continue
		}
		checkAgainstBruteForce(t, p)
	}
}

func checkAgainstBruteForce(t *testing.T, p *Problem) {
	t.Helper()
	sol, err := Solve(p)
	if err != nil {
		if _, berr := BruteForce(p); berr == nil {
			t.Fatalf("Solve failed (%v) but brute force found a schedule", err)
		}
		return // both agree the instance is infeasible
	}
	ref, err := BruteForce(p)
	if err != nil {
		t.Fatalf("BruteForce: %v", err)
	}
	if sol.TotalWait != ref.TotalWait || sol.Makespan != ref.Makespan {
		t.Fatalf("mismatch: solver wait=%d makespan=%d, brute wait=%d makespan=%d",
			sol.TotalWait, sol.Makespan, ref.TotalWait, ref.Makespan)
	}
	st := startsOf(sol, len(p.Ships))
	if !p.feasible(st) {
		t.Fatalf("solver produced infeasible starts %v", st)
	}
	for i, s := range p.Ships {
		if st[i] < s.Arrival {
			t.Fatalf("ship %q starts before arrival", s.ID)
		}
		if !p.inSomeWindow(st[i], st[i]+s.Duration) {
			t.Fatalf("ship %q outside tidal windows", s.ID)
		}
	}
}

// randomProblem builds a small instance with a bounded enumeration space.
// Returns nil when the draw has no feasible candidates; caller retries.
func randomProblem(rng *rand.Rand) *Problem {
	p := &Problem{
		BerthLength: 60 + 30*rng.Intn(5), // 60..180
		Step:        30,
	}
	nWin := 1 + rng.Intn(2)
	for w := 0; w < nWin; w++ {
		start := 30 * rng.Intn(30)
		p.Tides = append(p.Tides, Window{start, start + 120 + 30*rng.Intn(9)})
	}
	nShips := 2 + rng.Intn(4) // 2..5
	space := 1
	for i := 0; i < nShips; i++ {
		w := p.Tides[rng.Intn(len(p.Tides))]
		dur := 30 * (1 + rng.Intn(3)) // 30..90
		latest := w.End - dur
		if latest < w.Start {
			return nil
		}
		arr := w.Start + 30*rng.Intn((latest-w.Start)/30+1)
		s := Ship{
			ID:       string(rune('a' + i)),
			Length:   30 * (1 + rng.Intn(3)), // 30..90
			Arrival:  arr,
			Duration: dur,
		}
		c, err := p.Candidates(s)
		if err != nil {
			return nil
		}
		space *= len(c)
		if space > 100000 {
			return nil
		}
		p.Ships = append(p.Ships, s)
	}
	return p
}
