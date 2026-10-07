package main

import (
	"math/rand"
	"testing"
)

func row(s string) []bool {
	available := make([]bool, len(s))
	for i := 0; i < len(s); i++ {
		available[i] = s[i] == '.'
	}
	return available
}

// checkValid verifies that a Result is internally consistent: placements are
// on usable seats, never overlap, reproduce the reported distance, and the
// unseated count matches the seated people.
func checkValid(t *testing.T, available []bool, sizes []int, target int, res Result) {
	t.Helper()
	used := make([]bool, len(available))
	seated, dist := 0, 0
	for _, p := range res.Placements {
		s := sizes[p.Group]
		if p.Start < 0 || p.Start+s > len(available) {
			t.Fatalf("group %d placed out of row at %d", p.Group, p.Start)
		}
		for c := p.Start; c < p.Start+s; c++ {
			if !available[c] {
				t.Fatalf("group %d uses blocked seat %d", p.Group, c)
			}
			if used[c] {
				t.Fatalf("groups overlap at seat %d", c)
			}
			used[c] = true
			seated++
			if d := c - target; d < 0 {
				dist -= d
			} else {
				dist += d
			}
			if want := byte('A' + p.Group); res.Layout[c] != want {
				t.Fatalf("layout[%d] = %c, want %c", c, res.Layout[c], want)
			}
		}
	}
	for i, ok := range available {
		if !used[i] {
			want := byte('.')
			if !ok {
				want = '#'
			}
			if res.Layout[i] != want {
				t.Fatalf("layout[%d] = %c, want %c", i, res.Layout[i], want)
			}
		}
	}
	if dist != res.Distance {
		t.Fatalf("distance = %d, recomputed %d", res.Distance, dist)
	}
	total := 0
	for _, s := range sizes {
		total += s
	}
	if total-seated != res.Unseated {
		t.Fatalf("unseated = %d, recomputed %d", res.Unseated, total-seated)
	}
}

func TestSingleGroupNearestToTarget(t *testing.T) {
	res := Solve(row("....."), []int{2}, 2)
	checkValid(t, row("....."), []int{2}, 2, res)
	if res.Unseated != 0 || res.Distance != 1 {
		t.Fatalf("got unseated=%d distance=%d, want 0 and 1", res.Unseated, res.Distance)
	}
}

func TestBlockedSeatsSplitRow(t *testing.T) {
	available := row("..#..")
	res := Solve(available, []int{3, 2}, 0)
	checkValid(t, available, []int{3, 2}, 0, res)
	// The size-3 group fits nowhere; size-2 sits at columns 0-1 (dist 1).
	if res.Unseated != 3 || res.Distance != 1 || res.Layout != "BB#.." {
		t.Fatalf("got %+v", res)
	}
}

func TestUnseatedMinimizedBeforeDistance(t *testing.T) {
	available := row("...")
	res := Solve(available, []int{2, 2}, 0)
	checkValid(t, available, []int{2, 2}, 0, res)
	// Only one group fits; seat it at columns 0-1 (dist 1), 2 people out.
	if res.Unseated != 2 || res.Distance != 1 {
		t.Fatalf("got unseated=%d distance=%d, want 2 and 1", res.Unseated, res.Distance)
	}
}

func TestGroupsMayCrossEmptySeats(t *testing.T) {
	available := row(".....")
	res := Solve(available, []int{1, 1}, 4)
	checkValid(t, available, []int{1, 1}, 4, res)
	// Both singletons sit nearest to column 4: seats 4 and 3, dist 0+1.
	if res.Unseated != 0 || res.Distance != 1 {
		t.Fatalf("got unseated=%d distance=%d, want 0 and 1", res.Unseated, res.Distance)
	}
}

func TestAllBlocked(t *testing.T) {
	available := row("###")
	res := Solve(available, []int{1, 2}, 1)
	checkValid(t, available, []int{1, 2}, 1, res)
	if res.Unseated != 3 || res.Distance != 0 || res.Layout != "###" {
		t.Fatalf("got %+v", res)
	}
}

func TestTenGroups(t *testing.T) {
	available := row("..........")
	sizes := []int{1, 1, 1, 1, 1, 1, 1, 1, 1, 1}
	res := Solve(available, sizes, 0)
	checkValid(t, available, sizes, 0, res)
	// Everyone seated; distances 0+1+...+9 = 45.
	if res.Unseated != 0 || res.Distance != 45 {
		t.Fatalf("got unseated=%d distance=%d, want 0 and 45", res.Unseated, res.Distance)
	}
}

func TestGroupLargerThanRow(t *testing.T) {
	available := row("..")
	res := Solve(available, []int{5}, 0)
	checkValid(t, available, []int{5}, 0, res)
	if res.Unseated != 5 || res.Layout != ".." {
		t.Fatalf("got %+v", res)
	}
}

// TestMatchesBrute cross-checks the DP against exhaustive enumeration on
// short rows, comparing both objective levels and validating the layout.
func TestMatchesBrute(t *testing.T) {
	rng := rand.New(rand.NewSource(20261007))
	for trial := 0; trial < 2000; trial++ {
		n := 1 + rng.Intn(9) // row length 1..9
		g := 1 + rng.Intn(4) // 1..4 groups
		available := make([]bool, n)
		for i := range available {
			available[i] = rng.Intn(4) != 0 // 75% usable
		}
		sizes := make([]int, g)
		for i := range sizes {
			sizes[i] = 1 + rng.Intn(4)
		}
		target := rng.Intn(n)

		fast := Solve(available, sizes, target)
		slow := SolveBrute(available, sizes, target)
		checkValid(t, available, sizes, target, fast)
		checkValid(t, available, sizes, target, slow)
		if fast.Unseated != slow.Unseated || fast.Distance != slow.Distance {
			t.Fatalf("trial %d: n=%d g=%d target=%d avail=%v sizes=%v\nfast: unseated=%d dist=%d\nslow: unseated=%d dist=%d",
				trial, n, g, target, available, sizes,
				fast.Unseated, fast.Distance, slow.Unseated, slow.Distance)
		}
	}
}
