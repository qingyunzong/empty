package exactsum

import (
	"errors"
	"math"
	"math/big"
	"math/rand"
	"testing"
)

// Intermediate partial sums may overflow int64 as long as the final sum
// fits. A naive int64 accumulator would reject these cases.
func TestIntermediateOverflowCancels(t *testing.T) {
	a := New()
	a.AddPartition("g", math.MaxInt64, math.MaxInt64) // partial sum: 2*MaxInt64
	a.AddPartition("g", -math.MaxInt64, -math.MaxInt64)

	r := a.Result("g")
	if r.Err != nil {
		t.Fatalf("expected no error, got %v", r.Err)
	}
	if r.Sum != 0 {
		t.Fatalf("expected 0, got %d", r.Sum)
	}
}

func TestIntermediateUnderflowCancels(t *testing.T) {
	a := New()
	a.AddPartition("g", math.MinInt64, math.MinInt64) // partial sum: 2*MinInt64
	a.AddPartition("g", math.MaxInt64, 1, math.MaxInt64, 1)

	r := a.Result("g")
	if r.Err != nil {
		t.Fatalf("expected no error, got %v", r.Err)
	}
	if r.Sum != 0 {
		t.Fatalf("expected 0, got %d", r.Sum)
	}
}

// A group whose final sum overflows reports a per-group error while other
// groups in the same table still return valid sums.
func TestFinalOverflowIsPerGroup(t *testing.T) {
	a := New()
	a.AddPartition("bad", math.MaxInt64, 1)
	a.AddPartition("bad-neg", math.MinInt64, -1)
	a.AddPartition("ok", 40, 2)

	res := a.Results()
	if len(res) != 3 {
		t.Fatalf("expected 3 groups, got %d", len(res))
	}

	for _, g := range []string{"bad", "bad-neg"} {
		r := res[g]
		if r.Err == nil {
			t.Fatalf("group %q: expected overflow error, got sum %d", g, r.Sum)
		}
		if !errors.Is(r.Err, ErrOverflow) {
			t.Fatalf("group %q: error %v does not match ErrOverflow", g, r.Err)
		}
		var of *OverflowError
		if !errors.As(r.Err, &of) {
			t.Fatalf("group %q: error is not *OverflowError", g)
		}
		if of.Group != g {
			t.Fatalf("group %q: OverflowError.Group = %q", g, of.Group)
		}
	}

	if res["ok"].Err != nil || res["ok"].Sum != 42 {
		t.Fatalf("group ok: got %+v", res["ok"])
	}
}

func TestOverflowErrorCarriesExactSum(t *testing.T) {
	a := New()
	a.AddPartition("g", math.MaxInt64, 1)

	r := a.Result("g")
	var of *OverflowError
	if !errors.As(r.Err, &of) {
		t.Fatalf("expected *OverflowError, got %v", r.Err)
	}
	want := new(big.Int).Add(big.NewInt(math.MaxInt64), big.NewInt(1))
	if of.Sum.Cmp(want) != 0 {
		t.Fatalf("exact sum = %s, want %s", of.Sum, want)
	}
}

func TestBoundaryValues(t *testing.T) {
	cases := []struct {
		name   string
		values []int64
		want   int64
		err    bool
	}{
		{"max", []int64{math.MaxInt64}, math.MaxInt64, false},
		{"min", []int64{math.MinInt64}, math.MinInt64, false},
		{"max+min", []int64{math.MaxInt64, math.MinInt64}, -1, false},
		{"max+1", []int64{math.MaxInt64, 1}, 0, true},
		{"min-1", []int64{math.MinInt64, -1}, 0, true},
		{"empty", nil, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := New()
			a.AddPartition("g", tc.values...)
			r := a.Result("g")
			if tc.err {
				if !errors.Is(r.Err, ErrOverflow) {
					t.Fatalf("expected overflow, got %+v", r)
				}
				return
			}
			if r.Err != nil || r.Sum != tc.want {
				t.Fatalf("got %+v, want sum %d", r, tc.want)
			}
		})
	}
}

// referenceSum computes the exact sum with big.Int and whether it fits int64.
func referenceSum(values []int64) (*big.Int, bool) {
	total := new(big.Int)
	for _, v := range values {
		total.Add(total, big.NewInt(v))
	}
	return total, total.IsInt64()
}

// splitPartitions randomly partitions values into non-empty batches.
func splitPartitions(rng *rand.Rand, values []int64) [][]int64 {
	var parts [][]int64
	for i := 0; i < len(values); {
		n := 1 + rng.Intn(7)
		if i+n > len(values) {
			n = len(values) - i
		}
		parts = append(parts, values[i:i+n])
		i += n
	}
	return parts
}

// Random values, random partition layouts, and shuffled arrival orders must
// all agree with the big.Int reference, including per-group overflow errors.
func TestRandomPartitionReordering(t *testing.T) {
	rng := rand.New(rand.NewSource(20261007))

	for trial := 0; trial < 200; trial++ {
		groups := map[string][]int64{
			"alpha": nil, "beta": nil, "gamma": nil,
		}
		for g := range groups {
			n := rng.Intn(40)
			for i := 0; i < n; i++ {
				switch rng.Intn(4) {
				case 0:
					groups[g] = append(groups[g], int64(rng.Uint64()))
				case 1:
					groups[g] = append(groups[g], math.MaxInt64-int64(rng.Intn(4)))
				case 2:
					groups[g] = append(groups[g], math.MinInt64+int64(rng.Intn(4)))
				default:
					groups[g] = append(groups[g], int64(rng.Intn(2001)-1000))
				}
			}
		}

		// Expected outcomes from the big.Int reference.
		type want struct {
			sum   int64
			fits  bool
			total *big.Int
		}
		expected := map[string]want{}
		for g, vs := range groups {
			if len(vs) == 0 {
				continue // groups with no values never reach the aggregator
			}
			total, fits := referenceSum(vs)
			w := want{fits: fits, total: total}
			if fits {
				w.sum = total.Int64()
			}
			expected[g] = w
		}

		// Feed the same data under several random partition layouts and
		// arrival orders; every run must produce identical results.
		for run := 0; run < 5; run++ {
			a := New()
			type item struct {
				group string
				part  []int64
			}
			var items []item
			for g, vs := range groups {
				shuffled := append([]int64(nil), vs...)
				rng.Shuffle(len(shuffled), func(i, j int) {
					shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
				})
				for _, p := range splitPartitions(rng, shuffled) {
					items = append(items, item{g, p})
				}
			}
			rng.Shuffle(len(items), func(i, j int) {
				items[i], items[j] = items[j], items[i]
			})
			for _, it := range items {
				a.AddPartition(it.group, it.part...)
			}

			res := a.Results()
			if len(res) != len(expected) {
				t.Fatalf("trial %d run %d: got %d groups, want %d",
					trial, run, len(res), len(expected))
			}
			for g, w := range expected {
				r, ok := res[g]
				if !ok {
					t.Fatalf("trial %d run %d: missing group %q", trial, run, g)
				}
				if !w.fits {
					if !errors.Is(r.Err, ErrOverflow) {
						t.Fatalf("trial %d run %d group %q: expected overflow of %s, got %+v",
							trial, run, g, w.total, r)
					}
					continue
				}
				if r.Err != nil {
					t.Fatalf("trial %d run %d group %q: unexpected error %v (sum %s)",
						trial, run, g, r.Err, w.total)
				}
				if r.Sum != w.sum {
					t.Fatalf("trial %d run %d group %q: sum %d, want %d",
						trial, run, g, r.Sum, w.sum)
				}
			}
		}
	}
}

// Extreme cancellation: large opposing partitions must net to a small sum.
func TestMassiveCancellationAcrossPartitions(t *testing.T) {
	a := New()
	for i := 0; i < 100; i++ {
		a.AddPartition("g", math.MaxInt64, math.MinInt64) // each partition: -1
	}
	a.AddPartition("g", 100)
	r := a.Result("g")
	if r.Err != nil || r.Sum != 0 {
		t.Fatalf("got %+v, want sum 0", r)
	}
}
