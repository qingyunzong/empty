package main

import (
	"math/big"
	"math/rand"
	"testing"
)

func randomDecs(rng *rand.Rand, n int) []Dec {
	out := make([]Dec, n)
	for i := range out {
		d, err := Parse(randomLiteral(rng))
		if err != nil {
			panic(err)
		}
		out[i] = d
	}
	return out
}

func eqInts(a, b []*big.Int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Cmp(b[i]) != 0 {
			return false
		}
	}
	return true
}

// checkPrefixProperty verifies that the sum of the first k deltas equals
// round-half-even of the exact sum of the first k values, for every k.
func checkPrefixProperty(t *testing.T, vals []Dec, scale int, deltas []*big.Int) {
	t.Helper()
	exact := new(big.Rat)
	running := new(big.Int)
	for k, d := range deltas {
		exact.Add(exact, vals[k].Rat())
		running.Add(running, d)
		want := QuantizeRat(exact, scale)
		if running.Cmp(want) != 0 {
			t.Fatalf("prefix %d: delta sum %s != rounded exact sum %s", k+1, running, want)
		}
	}
}

// TestColumnChunkedVsNaive builds columns with several block sizes and
// compares deltas against the naive rational full accumulation.
func TestColumnChunkedVsNaive(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for _, block := range []int{1, 2, 3, 7, DefaultBlock} {
		for trial := 0; trial < 20; trial++ {
			scale := rng.Intn(5)
			vals := randomDecs(rng, 1+rng.Intn(200))
			col := NewColumn(scale)
			col.block = block
			for _, d := range vals {
				col.Append(d)
			}
			got := col.Deltas()
			want := NaiveDeltas(vals, scale)
			if !eqInts(got, want) {
				t.Fatalf("block=%d trial=%d: chunked deltas differ from naive", block, trial)
			}
			checkPrefixProperty(t, vals, scale, got)
		}
	}
}

// TestColumnRandomWithdrawals interleaves random appends and withdrawals,
// comparing against a from-scratch rational accumulation after every step.
func TestColumnRandomWithdrawals(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	for _, block := range []int{1, 2, 5, DefaultBlock} {
		scale := rng.Intn(4)
		col := NewColumn(scale)
		col.block = block
		var live []Dec
		for step := 0; step < 400; step++ {
			if len(live) == 0 || rng.Intn(3) > 0 {
				d := randomDecs(rng, 1)[0]
				col.Append(d)
				live = append(live, d)
			} else {
				i := rng.Intn(len(live))
				col.Withdraw(i)
				live = append(live[:i], live[i+1:]...)
			}
			got := col.Deltas()
			want := NaiveDeltas(live, scale)
			if !eqInts(got, want) {
				t.Fatalf("block=%d step=%d: deltas after mutation differ from rational full accumulation", block, step)
			}
		}
	}
}

// TestWithdrawRecomputesSuffix pins a concrete case where withdrawing one
// row changes the deltas of subsequent rows.
func TestWithdrawRecomputesSuffix(t *testing.T) {
	// scale 0; rows 0.5, 0.5, 0.5 -> cumulative 0.5->0, 1.0->1, 1.5->2
	// deltas: [0, 1, 1]. Withdrawing row 0 leaves 0.5, 0.5 -> [0, 1].
	mk := func(s string) Dec {
		d, err := Parse(s)
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	col := NewColumn(0)
	for _, s := range []string{"0.5", "0.5", "0.5"} {
		col.Append(mk(s))
	}
	got := col.Deltas()
	want := []string{"0", "1", "1"}
	for i, w := range want {
		if got[i].String() != w {
			t.Fatalf("before withdraw: delta[%d] = %s, want %s", i, got[i], w)
		}
	}
	col.Withdraw(0)
	got = col.Deltas()
	want = []string{"0", "1"}
	if len(got) != 2 {
		t.Fatalf("after withdraw: %d deltas, want 2", len(got))
	}
	for i, w := range want {
		if got[i].String() != w {
			t.Fatalf("after withdraw: delta[%d] = %s, want %s", i, got[i], w)
		}
	}
	// Withdrawing the middle row of 0.4, 0.4, 0.4 must shift the suffix:
	// full: cumulative 0.4->0, 0.8->1, 1.2->1 => deltas [0,1,0]
	// without middle: 0.4->0, 0.8->1 => deltas [0,1]
	col2 := NewColumn(0)
	for _, s := range []string{"0.4", "0.4", "0.4"} {
		col2.Append(mk(s))
	}
	col2.Deltas()
	col2.Withdraw(1)
	got = col2.Deltas()
	if got[0].String() != "0" || got[1].String() != "1" {
		t.Fatalf("suffix recompute wrong: got %v, %v", got[0], got[1])
	}
}

// TestWithdrawAllAndReappend exercises shrinking to empty and regrowing.
func TestWithdrawAllAndReappend(t *testing.T) {
	rng := rand.New(rand.NewSource(5))
	scale := 2
	col := NewColumn(scale)
	col.block = 3
	vals := randomDecs(rng, 10)
	for _, d := range vals {
		col.Append(d)
	}
	col.Deltas()
	for i := 9; i >= 0; i-- {
		col.Withdraw(i)
	}
	if got := col.Deltas(); len(got) != 0 {
		t.Fatalf("expected no deltas, got %d", len(got))
	}
	var live []Dec
	for i := 0; i < 25; i++ {
		d := randomDecs(rng, 1)[0]
		col.Append(d)
		live = append(live, d)
	}
	if got, want := col.Deltas(), NaiveDeltas(live, scale); !eqInts(got, want) {
		t.Fatal("regrown column diverges from naive accumulation")
	}
}
