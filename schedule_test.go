package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"strings"
	"testing"
	"time"
)

func mustSolve(t *testing.T, p Problem, brute bool) Solution {
	t.Helper()
	sol, err := Solve(p, brute)
	if err != nil {
		t.Fatalf("Solve(brute=%v) failed: %v", brute, err)
	}
	if err := ValidateSolution(p, sol); err != nil {
		t.Fatalf("invalid solution: %v", err)
	}
	return sol
}

// Half-open occupancy: a ship ending at t allows the next to start at t,
// so zero total waiting is achievable back-to-back on one berth.
func TestHalfOpenAdjacency(t *testing.T) {
	p := Problem{
		Berths: []Berth{{ID: "B1", Length: 300}},
		Ships: []Ship{
			{ID: "S1", Length: 100, Arrival: 0, Duration: 120,
				TidalWindows: []Window{{0, 600}}, Candidates: []int{0}},
			{ID: "S2", Length: 100, Arrival: 0, Duration: 60,
				TidalWindows: []Window{{0, 600}}, Candidates: []int{0, 120, 240}},
		},
	}
	sol := mustSolve(t, p, false)
	// S2 waits exactly until S1's occupancy ends: wait = 120 - 0.
	if sol.TotalWait != 120 {
		t.Fatalf("total wait = %d, want 120", sol.TotalWait)
	}
	for _, a := range sol.Assignments {
		if a.Ship == "S2" && a.Start != 120 {
			t.Fatalf("S2 starts at %d, want 120 (adjacent half-open)", a.Start)
		}
	}
}

// Absolute times may exceed 1440: a ship can occupy a berth across midnight.
func TestCrossMidnight(t *testing.T) {
	p := Problem{
		Berths: []Berth{{ID: "B1", Length: 300}},
		Ships: []Ship{
			{ID: "S1", Length: 100, Arrival: 1380, Duration: 120,
				TidalWindows: []Window{{1320, 1560}}, Candidates: []int{1380, 1440}},
		},
	}
	sol := mustSolve(t, p, false)
	a := sol.Assignments[0]
	if a.Start != 1380 || a.End != 1500 {
		t.Fatalf("got [%d, %d), want [1380, 1500)", a.Start, a.End)
	}
}

// A candidate that starts inside a tidal window but ends outside it is
// infeasible and must be skipped.
func TestTidalWindowContainment(t *testing.T) {
	p := Problem{
		Berths: []Berth{{ID: "B1", Length: 300}},
		Ships: []Ship{
			{ID: "S1", Length: 100, Arrival: 0, Duration: 120,
				TidalWindows: []Window{{0, 90}, {100, 400}},
				Candidates:   []int{0, 60, 100}},
		},
	}
	sol := mustSolve(t, p, false)
	if sol.Assignments[0].Start != 100 {
		t.Fatalf("start = %d, want 100 (only candidate fully inside a window)", sol.Assignments[0].Start)
	}
}

// Ships longer than a berth can only use longer berths.
func TestBerthLengthConstraint(t *testing.T) {
	p := Problem{
		Berths: []Berth{{ID: "short", Length: 100}, {ID: "long", Length: 250}},
		Ships: []Ship{
			{ID: "big", Length: 200, Arrival: 0, Duration: 60,
				TidalWindows: []Window{{0, 600}}, Candidates: []int{0}},
			{ID: "small", Length: 80, Arrival: 0, Duration: 60,
				TidalWindows: []Window{{0, 600}}, Candidates: []int{0}},
		},
	}
	sol := mustSolve(t, p, false)
	berthOf := map[string]string{}
	for _, a := range sol.Assignments {
		berthOf[a.Ship] = a.Berth
	}
	if berthOf["big"] != "long" {
		t.Fatalf("big ship on berth %q, want \"long\"", berthOf["big"])
	}
	if sol.TotalWait != 0 {
		t.Fatalf("total wait = %d, want 0", sol.TotalWait)
	}

	p.Berths = p.Berths[:1]
	if _, err := Solve(p, false); err == nil {
		t.Fatal("expected infeasible error when no berth fits the big ship")
	}
}

func TestInfeasibleNoCandidateInWindow(t *testing.T) {
	p := Problem{
		Berths: []Berth{{ID: "B1", Length: 300}},
		Ships: []Ship{
			{ID: "S1", Length: 100, Arrival: 0, Duration: 120,
				TidalWindows: []Window{{500, 700}}, Candidates: []int{0, 60}},
		},
	}
	if _, err := Solve(p, false); err == nil {
		t.Fatal("expected infeasible error")
	}
	if _, err := Solve(p, true); err == nil {
		t.Fatal("expected infeasible error from brute force")
	}
}

func TestValidationRejectsBadInput(t *testing.T) {
	base := Problem{
		Berths: []Berth{{ID: "B1", Length: 100}},
		Ships: []Ship{
			{ID: "S1", Length: 50, Arrival: 10, Duration: 30,
				TidalWindows: []Window{{0, 100}}, Candidates: []int{10}},
		},
	}
	bad := base
	bad.Ships = append([]Ship{}, base.Ships...)
	bad.Ships[0].Candidates = []int{5} // before arrival
	if _, err := Solve(bad, false); err == nil {
		t.Fatal("expected error for candidate before arrival")
	}
	many := base
	for i := 0; i < 13; i++ {
		s := base.Ships[0]
		s.ID = fmt.Sprintf("S%d", i)
		many.Ships = append(many.Ships, s)
	}
	many.Ships = many.Ships[1:]
	if _, err := Solve(many, false); err == nil {
		t.Fatal("expected error for more than 12 ships")
	}
}

// randomProblem builds a small random instance. Candidates are discrete
// (hourly) and tidal windows are sometimes tight so that some instances
// are infeasible.
func randomProblem(r *rand.Rand) Problem {
	nBerths := 1 + r.Intn(2)
	p := Problem{}
	for i := 0; i < nBerths; i++ {
		p.Berths = append(p.Berths, Berth{ID: fmt.Sprintf("B%d", i), Length: 100 + 50*r.Intn(5)})
	}
	nShips := 2 + r.Intn(5)
	for i := 0; i < nShips; i++ {
		arrival := 60 * r.Intn(10)
		duration := 60 * (1 + r.Intn(3))
		var cands []int
		for c := arrival; c <= arrival+360; c += 60 {
			cands = append(cands, c)
		}
		var windows []Window
		if r.Float64() < 0.3 {
			// tight window: may exclude some or all candidates
			ws := arrival + 60*r.Intn(3)
			windows = append(windows, Window{ws, ws + duration + 60*r.Intn(3)})
		} else {
			windows = append(windows, Window{0, 2880})
		}
		p.Ships = append(p.Ships, Ship{
			ID: fmt.Sprintf("S%d", i), Length: 50 + 50*r.Intn(5),
			Arrival: arrival, Duration: duration,
			TidalWindows: windows, Candidates: cands,
		})
	}
	return p
}

// The branch-and-bound solver must agree with plain exhaustive
// enumeration on the optimum (and on infeasibility) for small cases.
func TestExactMatchesBruteForce(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	for trial := 0; trial < 300; trial++ {
		p := randomProblem(r)
		exact, errE := Solve(p, false)
		brute, errB := Solve(p, true)
		if (errE == nil) != (errB == nil) {
			t.Fatalf("trial %d: feasibility mismatch: exact=%v brute=%v", trial, errE, errB)
		}
		if errE != nil {
			continue
		}
		if exact.TotalWait != brute.TotalWait || exact.TotalEnd != brute.TotalEnd {
			t.Fatalf("trial %d: exact=(wait %d,end %d) brute=(wait %d,end %d)",
				trial, exact.TotalWait, exact.TotalEnd, brute.TotalWait, brute.TotalEnd)
		}
		if err := ValidateSolution(p, exact); err != nil {
			t.Fatalf("trial %d: invalid exact solution: %v", trial, err)
		}
		if err := ValidateSolution(p, brute); err != nil {
			t.Fatalf("trial %d: invalid brute solution: %v", trial, err)
		}
	}
}

// Twelve contested ships on two berths must solve quickly.
func TestTwelveShips(t *testing.T) {
	p := Problem{
		Berths: []Berth{{ID: "B1", Length: 300}, {ID: "B2", Length: 200}},
	}
	for i := 0; i < 12; i++ {
		arrival := 45 * i
		var cands []int
		for c := arrival; c <= arrival+180; c += 60 {
			cands = append(cands, c)
		}
		length := 150
		if i%3 == 0 {
			length = 250 // only fits B1
		}
		p.Ships = append(p.Ships, Ship{
			ID: fmt.Sprintf("S%02d", i), Length: length,
			Arrival: arrival, Duration: 60,
			TidalWindows: []Window{{0, 2000}}, Candidates: cands,
		})
	}
	start := time.Now()
	sol := mustSolve(t, p, false)
	elapsed := time.Since(start)
	if elapsed > 5*time.Second {
		t.Fatalf("12-ship solve took %v", elapsed)
	}
	t.Logf("12 ships solved in %v, total wait %d", elapsed, sol.TotalWait)
}

// End-to-end: feed JSON through the CLI entry point and validate output.
func TestCLIEndToEnd(t *testing.T) {
	input := `{
	  "berths": [{"id": "B1", "length": 300}],
	  "ships": [
	    {"id": "S1", "length": 100, "arrival": 60, "duration": 120,
	     "tidal_windows": [{"start": 0, "end": 480}], "candidates": [60, 120]},
	    {"id": "S2", "length": 100, "arrival": 60, "duration": 60,
	     "tidal_windows": [{"start": 0, "end": 480}], "candidates": [60, 180]}
	  ]
	}`
	var out bytes.Buffer
	if err := run(nil, strings.NewReader(input), &out); err != nil {
		t.Fatalf("run failed: %v", err)
	}
	var sol Solution
	if err := json.Unmarshal(out.Bytes(), &sol); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}
	// S2@60 then S1@120 gives wait 0+60; S1@60 then S2@180 gives 120.
	if sol.TotalWait != 60 {
		t.Fatalf("total wait = %d, want 60", sol.TotalWait)
	}
}
