package regalloc

import (
	"math/rand"
	"testing"
)

func iv(id string, start, end int, load, store int64) Interval {
	return Interval{ID: id, Start: start, End: end, LoadCost: load, StoreCost: store}
}

func solveCost(t *testing.T, in *Input) int64 {
	t.Helper()
	out, err := Solve(in)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if !out.Feasible {
		t.Fatalf("expected feasible, got reason %q", out.Reason)
	}
	if err := Verify(in, out); err != nil {
		t.Fatalf("certificate invalid: %v", err)
	}
	if !out.Verified {
		t.Fatalf("solver did not self-verify")
	}
	return out.Cost
}

func TestSingleIntervalNoCost(t *testing.T) {
	in := &Input{NumRegisters: 4, Intervals: []Interval{iv("a", 0, 5, 1, 1)}}
	if got := solveCost(t, in); got != 0 {
		t.Fatalf("cost = %d, want 0", got)
	}
}

func TestSpillForcedByPressure(t *testing.T) {
	// Five intervals, four registers. "e" must be in a register at both of
	// its points (definition and last use), so one of the long intervals
	// has to be spilled around point 1: store 5 + load 5.
	in := &Input{
		NumRegisters: 4,
		Intervals: []Interval{
			iv("a", 0, 4, 5, 5),
			iv("b", 0, 4, 5, 5),
			iv("c", 0, 4, 5, 5),
			iv("d", 0, 4, 5, 5),
			iv("e", 1, 3, 1, 2),
		},
	}
	if got := solveCost(t, in); got != 10 {
		t.Fatalf("cost = %d, want 10 (store 5 + load 5)", got)
	}
}

func TestSpillAndReload(t *testing.T) {
	// "long" must leave its register while the four short intervals are
	// live, and is needed again afterwards: store + load.
	in := &Input{
		NumRegisters: 4,
		Intervals: []Interval{
			iv("long", 0, 8, 3, 4),
			iv("a", 2, 4, 9, 9),
			iv("b", 2, 4, 9, 9),
			iv("c", 2, 4, 9, 9),
			iv("d", 2, 4, 9, 9),
		},
	}
	if got := solveCost(t, in); got != 7 {
		t.Fatalf("cost = %d, want 7 (store 4 + load 3)", got)
	}
}

func TestCallReservedForcesSpill(t *testing.T) {
	// One interval live across a call that reserves all four registers:
	// it must be spilled before the call and reloaded after.
	in := &Input{
		NumRegisters: 4,
		Intervals:    []Interval{iv("x", 0, 6, 2, 3)},
		Calls:        []Call{{Point: 3, Reserved: []int{0, 1, 2, 3}}},
	}
	out, err := Solve(in)
	if err != nil {
		t.Fatal(err)
	}
	if !out.Feasible {
		t.Fatalf("infeasible: %s", out.Reason)
	}
	if out.Cost != 5 {
		t.Fatalf("cost = %d, want 5 (store 3 + load 2)", out.Cost)
	}
	for _, ps := range out.Occupancy {
		if ps.Point == 3 {
			if len(ps.Assignment) != 1 || ps.Assignment[0].Reg != -1 {
				t.Fatalf("point 3: interval must be in memory, got %+v", ps.Assignment)
			}
		}
	}
	if err := Verify(in, out); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

func TestCallReservedSubset(t *testing.T) {
	// Two intervals live across a call reserving two registers: both fit
	// in the remaining registers, no cost.
	in := &Input{
		NumRegisters: 4,
		Intervals: []Interval{
			iv("x", 0, 6, 1, 1),
			iv("y", 0, 6, 1, 1),
		},
		Calls: []Call{{Point: 3, Reserved: []int{0, 1}}},
	}
	if got := solveCost(t, in); got != 0 {
		t.Fatalf("cost = %d, want 0", got)
	}
}

func TestInfeasibleTooManyStarts(t *testing.T) {
	in := &Input{
		NumRegisters: 4,
		Intervals: []Interval{
			iv("a", 0, 2, 1, 1), iv("b", 0, 2, 1, 1), iv("c", 0, 2, 1, 1),
			iv("d", 0, 2, 1, 1), iv("e", 0, 2, 1, 1),
		},
	}
	out, err := Solve(in)
	if err != nil {
		t.Fatal(err)
	}
	if out.Feasible {
		t.Fatalf("expected infeasible, got cost %d", out.Cost)
	}
}

func TestInfeasibleStartAtFullyReservedCall(t *testing.T) {
	in := &Input{
		NumRegisters: 4,
		Intervals:    []Interval{iv("a", 2, 5, 1, 1)},
		Calls:        []Call{{Point: 2, Reserved: []int{0, 1, 2, 3}}},
	}
	out, err := Solve(in)
	if err != nil {
		t.Fatal(err)
	}
	if out.Feasible {
		t.Fatalf("expected infeasible, got cost %d", out.Cost)
	}
}

func TestSixteenIntervals(t *testing.T) {
	// 16 staggered intervals, 4 registers: exercises the size limits.
	in := &Input{NumRegisters: 4}
	for i := 0; i < 16; i++ {
		in.Intervals = append(in.Intervals, Interval{
			ID:        string(rune('a' + i)),
			Start:     i,
			End:       i + 5,
			LoadCost:  int64(i%3 + 1),
			StoreCost: int64(i%2 + 1),
		})
	}
	in.Calls = []Call{{Point: 10, Reserved: []int{2, 3}}}
	out, err := Solve(in)
	if err != nil {
		t.Fatal(err)
	}
	if !out.Feasible {
		t.Fatalf("infeasible: %s", out.Reason)
	}
	if err := Verify(in, out); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

func TestValidationLimits(t *testing.T) {
	in := &Input{NumRegisters: 5, Intervals: []Interval{iv("a", 0, 1, 1, 1)}}
	if err := in.Validate(); err == nil {
		t.Fatal("expected error for >4 registers")
	}
	in = &Input{NumRegisters: 4}
	for i := 0; i < 17; i++ {
		in.Intervals = append(in.Intervals, iv(string(rune('a'+i)), 0, 1, 1, 1))
	}
	if err := in.Validate(); err == nil {
		t.Fatal("expected error for >16 intervals")
	}
}

// randomInput builds a small random instance for cross-checking.
func randomInput(rng *rand.Rand) *Input {
	n := 1 + rng.Intn(6)
	in := &Input{NumRegisters: 1 + rng.Intn(4)}
	for i := 0; i < n; i++ {
		start := rng.Intn(6)
		in.Intervals = append(in.Intervals, Interval{
			ID:        string(rune('a' + i)),
			Start:     start,
			End:       start + 1 + rng.Intn(4),
			LoadCost:  int64(rng.Intn(4)),
			StoreCost: int64(rng.Intn(4)),
		})
	}
	for c := 0; c < rng.Intn(3); c++ {
		var res []int
		for r := 0; r < in.NumRegisters; r++ {
			if rng.Intn(2) == 0 {
				res = append(res, r)
			}
		}
		in.Calls = append(in.Calls, Call{Point: rng.Intn(9), Reserved: res})
	}
	return in
}

func TestDPvsBruteForceRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for trial := 0; trial < 400; trial++ {
		in := randomInput(rng)
		out, err := Solve(in)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		bCost, bFeasible := BruteForce(in)
		if out.Feasible != bFeasible {
			t.Fatalf("trial %d: DP feasible=%v, brute feasible=%v\ninput: %+v",
				trial, out.Feasible, bFeasible, in)
		}
		if !out.Feasible {
			continue
		}
		if out.Cost != bCost {
			t.Fatalf("trial %d: DP cost %d != brute cost %d\ninput: %+v",
				trial, out.Cost, bCost, in)
		}
		if err := Verify(in, out); err != nil {
			t.Fatalf("trial %d: certificate invalid: %v", trial, err)
		}
	}
}

func TestCertificateDetectsTampering(t *testing.T) {
	in := &Input{
		NumRegisters: 4,
		Intervals: []Interval{
			iv("long", 0, 8, 3, 4),
			iv("a", 2, 4, 9, 9), iv("b", 2, 4, 9, 9),
			iv("c", 2, 4, 9, 9), iv("d", 2, 4, 9, 9),
		},
	}
	out, err := Solve(in)
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(in, out); err != nil {
		t.Fatalf("honest certificate rejected: %v", err)
	}
	out.Cost--
	if err := Verify(in, out); err == nil {
		t.Fatal("tampered cost accepted")
	}
}
