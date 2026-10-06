package cumround

import (
	"math/big"
	"math/rand"
	"testing"

	"jsonnum/decimal"
)

func rat(s string) *big.Rat {
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		panic("bad rational: " + s)
	}
	return r
}

func stringsOf(xs []*big.Int) []string {
	out := make([]string, len(xs))
	for i, x := range xs {
		out[i] = x.String()
	}
	return out
}

func equalInts(a, b []*big.Int) bool {
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

func TestDeltasKnown(t *testing.T) {
	amounts := []*big.Rat{rat("1/200"), rat("1/200"), rat("1/200"), rat("1/200")}
	// cumulative scaled by 100: 0.5 -> 0, 1.0 -> 1, 1.5 -> 2, 2.0 -> 2
	got := stringsOf(Deltas(amounts, 2))
	want := []string{"0", "1", "1", "0"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Deltas = %v, want %v", got, want)
		}
	}
}

// TestDeltasInvariant verifies the defining property: the sum of the first
// k deltas equals round-half-even of the exact sum of the first k amounts.
func TestDeltasInvariant(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for trial := 0; trial < 50; trial++ {
		n := 1 + rng.Intn(100)
		scale := rng.Intn(7) - 2
		amounts := randomRats(rng, n)
		deltas := Deltas(amounts, scale)
		cum := new(big.Rat)
		run := new(big.Int)
		for k, a := range amounts {
			cum.Add(cum, a)
			run.Add(run, deltas[k])
			want := decimal.RoundRatHalfEven(cum, scale)
			if run.Cmp(want) != 0 {
				t.Fatalf("trial %d: sum of first %d deltas = %s, rounded exact sum = %s",
					trial, k+1, run, want)
			}
		}
	}
}

// randomRats generates random rationals, including non-terminating
// denominators, to stress exact rational accumulation.
func randomRats(rng *rand.Rand, n int) []*big.Rat {
	dens := []int64{1, 2, 3, 4, 5, 7, 8, 10, 20, 25, 100, 1000, 6, 9, 11}
	out := make([]*big.Rat, n)
	for i := range out {
		num := int64(rng.Intn(2000001) - 1000000)
		den := dens[rng.Intn(len(dens))]
		out[i] = big.NewRat(num, den)
	}
	return out
}

// TestChunkedMatchesFull feeds the column through State in random chunks and
// compares with the one-shot full-column computation.
func TestChunkedMatchesFull(t *testing.T) {
	rng := rand.New(rand.NewSource(11))
	for trial := 0; trial < 30; trial++ {
		n := 1 + rng.Intn(300)
		scale := rng.Intn(7) - 2
		amounts := randomRats(rng, n)
		full := Deltas(amounts, scale)

		st := NewState(scale)
		var got []*big.Int
		i := 0
		for i < n {
			chunk := 1 + rng.Intn(37)
			for ; i < n && chunk > 0; i, chunk = i+1, chunk-1 {
				got = append(got, st.Append(amounts[i]))
			}
		}
		if !equalInts(got, full) {
			t.Fatalf("trial %d: chunked deltas differ from full computation", trial)
		}
	}
}

// TestRandomWithdrawals performs random row withdrawals; after each one the
// incrementally recomputed deltas are compared against a full rational
// cumulative recomputation of the remaining rows.
func TestRandomWithdrawals(t *testing.T) {
	rng := rand.New(rand.NewSource(23))
	for trial := 0; trial < 20; trial++ {
		n := 2 + rng.Intn(150)
		scale := rng.Intn(7) - 2
		amounts := randomRats(rng, n)
		deltas := Deltas(amounts, scale)
		for len(amounts) > 1 {
			i := rng.Intn(len(amounts))
			prev := deltas
			amounts, deltas = Withdraw(amounts, deltas, scale, i)

			// Rows before i keep their deltas.
			for j := 0; j < i; j++ {
				if deltas[j].Cmp(prev[j]) != 0 {
					t.Fatalf("trial %d: prefix delta %d changed after withdrawal", trial, j)
				}
			}
			// Full rational cumulative reference.
			want := Deltas(amounts, scale)
			if !equalInts(deltas, want) {
				t.Fatalf("trial %d: deltas after withdrawing row %d differ from full recomputation", trial, i)
			}
		}
	}
}

// TestWithdrawBoundary covers first/last/only-row withdrawals.
func TestWithdrawBoundary(t *testing.T) {
	amounts := []*big.Rat{rat("1/3"), rat("1/3"), rat("1/3")}
	deltas := Deltas(amounts, 2)
	for _, i := range []int{2, 0, 0} {
		amounts, deltas = Withdraw(amounts, deltas, 2, i)
		want := Deltas(amounts, 2)
		if !equalInts(deltas, want) {
			t.Fatalf("after withdrawing index %d: got %v, want %v", i, stringsOf(deltas), stringsOf(want))
		}
	}
	if len(amounts) != 0 || len(deltas) != 0 {
		t.Fatalf("expected empty column, got %d rows", len(amounts))
	}
}
