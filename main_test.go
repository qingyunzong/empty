package main

import (
	"math"
	"math/rand"
	"strings"
	"testing"
)

// bruteForce is an independent reference: it enumerates the full Cartesian
// product of every group's candidate placements (every segment that fits in
// a row and avoids blocked seats, plus "unseated"), rejects overlapping
// combinations, and returns the best (unseated, distance) pair.
func bruteForce(p Problem) (int, int) {
	type cand struct{ row, start int } // row == -1 means unseated
	perGroup := make([][]cand, len(p.Groups))
	for g, size := range p.Groups {
		cs := []cand{{row: -1}}
		for r, row := range p.Rows {
			for start := 0; start+size <= row.Length; start++ {
				ok := true
				for c := start; c < start+size; c++ {
					if row.Blocked[c] {
						ok = false
						break
					}
				}
				if ok {
					cs = append(cs, cand{r, start})
				}
			}
		}
		perGroup[g] = cs
	}

	bestU, bestD := math.MaxInt, math.MaxInt
	choice := make([]cand, len(p.Groups))
	var rec func(g int)
	rec = func(g int) {
		if g == len(p.Groups) {
			occ := map[[2]int]bool{}
			unseated, dist, conflict := 0, 0, false
			for gi, ch := range choice {
				if ch.row == -1 {
					unseated += p.Groups[gi]
					continue
				}
				for c := ch.start; c < ch.start+p.Groups[gi]; c++ {
					k := [2]int{ch.row, c}
					if occ[k] {
						conflict = true
					}
					occ[k] = true
					dist += abs(c - p.TargetCol)
				}
			}
			if conflict {
				return
			}
			if unseated < bestU || (unseated == bestU && dist < bestD) {
				bestU, bestD = unseated, dist
			}
			return
		}
		for _, ch := range perGroup[g] {
			choice[g] = ch
			rec(g + 1)
		}
	}
	rec(0)
	return bestU, bestD
}

// checkValid verifies a solution respects blocked seats and never overlaps.
func checkValid(t *testing.T, p Problem, s Solution) {
	t.Helper()
	occ := map[[2]int]bool{}
	seatedGroups := map[int]bool{}
	for _, pl := range s.Placements {
		if seatedGroups[pl.Group] {
			t.Fatalf("group %d placed twice", pl.Group)
		}
		seatedGroups[pl.Group] = true
		size := p.Groups[pl.Group]
		if pl.Start < 0 || pl.Start+size > p.Rows[pl.Row].Length {
			t.Fatalf("group %d out of row bounds", pl.Group)
		}
		for c := pl.Start; c < pl.Start+size; c++ {
			if p.Rows[pl.Row].Blocked[c] {
				t.Fatalf("group %d on blocked seat (%d,%d)", pl.Group, pl.Row, c)
			}
			k := [2]int{pl.Row, c}
			if occ[k] {
				t.Fatalf("overlap at (%d,%d)", pl.Row, c)
			}
			occ[k] = true
		}
	}
	// Recompute the objective from scratch.
	unseated, dist := 0, 0
	for g, size := range p.Groups {
		if !seatedGroups[g] {
			unseated += size
		}
	}
	for _, pl := range s.Placements {
		for c := pl.Start; c < pl.Start+p.Groups[pl.Group]; c++ {
			dist += abs(c - p.TargetCol)
		}
	}
	if unseated != s.Unseated || dist != s.Distance {
		t.Fatalf("reported (%d,%d), recomputed (%d,%d)", s.Unseated, s.Distance, unseated, dist)
	}
}

func TestBlockedSplitsRow(t *testing.T) {
	p := Problem{
		Rows:      []Row{{Length: 5, Blocked: map[int]bool{2: true}}},
		Groups:    []int{3},
		TargetCol: 0,
	}
	sol := Solve(p)
	if sol.Unseated != 3 {
		t.Fatalf("group of 3 must not cross a blocked seat, got unseated=%d", sol.Unseated)
	}
	p.Groups = []int{2}
	sol = Solve(p)
	if sol.Unseated != 0 || sol.Distance != 1 { // seats 0,1
		t.Fatalf("got unseated=%d distance=%d, want 0,1", sol.Unseated, sol.Distance)
	}
}

func TestMinimizeUnseatedPeopleFirst(t *testing.T) {
	// Row fits either the 3-person or the 2-person group, not both.
	// Seating the larger group leaves fewer people unseated.
	p := Problem{
		Rows:      []Row{{Length: 3}},
		Groups:    []int{2, 3},
		TargetCol: 0,
	}
	sol := Solve(p)
	checkValid(t, p, sol)
	if sol.Unseated != 2 {
		t.Fatalf("want unseated=2, got %d", sol.Unseated)
	}
	if len(sol.Placements) != 1 || sol.Placements[0].Group != 1 {
		t.Fatalf("the 3-person group should be seated: %+v", sol.Placements)
	}
}

func TestDistanceTieBreak(t *testing.T) {
	// Many positions seat everyone; the one nearest TargetCol wins.
	p := Problem{
		Rows:      []Row{{Length: 6}},
		Groups:    []int{2},
		TargetCol: 4,
	}
	sol := Solve(p)
	checkValid(t, p, sol)
	if sol.Unseated != 0 || sol.Distance != 1 { // seats 3,4 -> |3-4|+|4-4| = 1
		t.Fatalf("got unseated=%d distance=%d, want 0,1", sol.Unseated, sol.Distance)
	}
	if sol.Placements[0].Start != 3 {
		t.Fatalf("want start=3, got %d", sol.Placements[0].Start)
	}
}

func TestNoRowFits(t *testing.T) {
	p := Problem{
		Rows:      []Row{{Length: 2}, {Length: 3, Blocked: map[int]bool{1: true}}},
		Groups:    []int{4, 1},
		TargetCol: 0,
	}
	sol := Solve(p)
	checkValid(t, p, sol)
	if sol.Unseated != 4 { // only the single person gets a seat
		t.Fatalf("want unseated=4, got %d", sol.Unseated)
	}
}

func TestLayout(t *testing.T) {
	p := Problem{
		Rows:      []Row{{Length: 4, Blocked: map[int]bool{1: true}}},
		Groups:    []int{2},
		TargetCol: 0,
	}
	sol := Solve(p)
	out := Layout(p, sol)
	if !strings.Contains(out, "row 0: .#AA") {
		t.Fatalf("unexpected layout:\n%s", out)
	}
	if !strings.Contains(out, "unseated=0") {
		t.Fatalf("missing summary:\n%s", out)
	}
}

// TestAgainstBruteForce verifies Solve against full enumeration on many
// small random instances (short rows, few groups).
func TestAgainstBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for iter := 0; iter < 2000; iter++ {
		nRows := 1 + rng.Intn(3)
		rows := make([]Row, nRows)
		for r := range rows {
			length := 1 + rng.Intn(7)
			blocked := map[int]bool{}
			for c := 0; c < length; c++ {
				if rng.Intn(4) == 0 {
					blocked[c] = true
				}
			}
			rows[r] = Row{Length: length, Blocked: blocked}
		}
		nGroups := 1 + rng.Intn(4)
		groups := make([]int, nGroups)
		for g := range groups {
			groups[g] = 1 + rng.Intn(4)
		}
		p := Problem{Rows: rows, Groups: groups, TargetCol: rng.Intn(7)}

		sol := Solve(p)
		checkValid(t, p, sol)
		wantU, wantD := bruteForce(p)
		if sol.Unseated != wantU || sol.Distance != wantD {
			t.Fatalf("iter %d: got (%d,%d), brute force (%d,%d)\nproblem: %+v",
				iter, sol.Unseated, sol.Distance, wantU, wantD, p)
		}
	}
}
