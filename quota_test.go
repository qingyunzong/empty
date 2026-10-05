package quota

import (
	"math"
	"math/big"
	"math/rand"
	"sync"
	"testing"
)

// TestExtremeBoundaries drives counters to the uint64 extremes and checks
// that overflowing increments and underflowing refunds are rejected
// without changing state.
func TestExtremeBoundaries(t *testing.T) {
	l := New()
	l.SetLimit("s", math.MaxUint64)

	if err := l.Apply([]Op{{Subject: "s", Amount: math.MaxUint64}}); err != nil {
		t.Fatalf("charge to exactly MaxUint64 rejected: %v", err)
	}
	if got := l.Usage("s"); got != math.MaxUint64 {
		t.Fatalf("usage = %d, want %d", got, uint64(math.MaxUint64))
	}

	if err := l.Apply([]Op{{Subject: "s", Amount: 1}}); err == nil {
		t.Fatal("increment past MaxUint64 accepted, want overflow rejection")
	}
	if got := l.Usage("s"); got != math.MaxUint64 {
		t.Fatalf("usage changed after rejected overflow: %d", got)
	}

	if err := l.Apply([]Op{{Subject: "s", Amount: math.MaxUint64, Refund: true}}); err != nil {
		t.Fatalf("refund of full balance rejected: %v", err)
	}
	if got := l.Usage("s"); got != 0 {
		t.Fatalf("usage = %d, want 0", got)
	}

	if err := l.Apply([]Op{{Subject: "s", Amount: 1, Refund: true}}); err == nil {
		t.Fatal("refund below zero accepted, want underflow rejection")
	}
	if got := l.Usage("s"); got != 0 {
		t.Fatalf("usage changed after rejected underflow: %d", got)
	}
}

// TestLimitEnforcement rejects increments that fit in uint64 but exceed
// the subject's configured limit.
func TestLimitEnforcement(t *testing.T) {
	l := New()
	l.SetLimit("s", 100)

	if err := l.Apply([]Op{{Subject: "s", Amount: 100}}); err != nil {
		t.Fatalf("charge up to limit rejected: %v", err)
	}
	if err := l.Apply([]Op{{Subject: "s", Amount: 1}}); err == nil {
		t.Fatal("charge past limit accepted")
	}
	if got := l.Usage("s"); got != 100 {
		t.Fatalf("usage = %d, want 100", got)
	}
}

// TestBatchAtomicReject mixes subjects in one batch; a single illegal op
// must reject the whole batch and leave every counter untouched.
func TestBatchAtomicReject(t *testing.T) {
	l := New()
	l.SetLimit("a", 1000)
	l.SetLimit("b", 10)

	if err := l.Apply([]Op{{Subject: "a", Amount: 500}, {Subject: "b", Amount: 5}}); err != nil {
		t.Fatalf("seed batch rejected: %v", err)
	}

	bad := []Op{
		{Subject: "a", Amount: 100}, // legal on its own
		{Subject: "b", Amount: 6},   // exceeds b's limit
		{Subject: "a", Amount: 1, Refund: true},
	}
	if err := l.Apply(bad); err == nil {
		t.Fatal("batch with limit breach accepted")
	}
	if got := l.Usage("a"); got != 500 {
		t.Fatalf("a mutated by rejected batch: %d", got)
	}
	if got := l.Usage("b"); got != 5 {
		t.Fatalf("b mutated by rejected batch: %d", got)
	}

	under := []Op{
		{Subject: "a", Amount: 100, Refund: true},
		{Subject: "b", Amount: 6, Refund: true}, // underflows b (usage 5)
	}
	if err := l.Apply(under); err == nil {
		t.Fatal("batch with underflow accepted")
	}
	if got := l.Usage("a"); got != 500 {
		t.Fatalf("a mutated by rejected batch: %d", got)
	}
	if got := l.Usage("b"); got != 5 {
		t.Fatalf("b mutated by rejected batch: %d", got)
	}
}

// TestBatchMultiSubjectCommit checks that a fully legal multi-subject
// batch commits every op, applied in batch order.
func TestBatchMultiSubjectCommit(t *testing.T) {
	l := New()
	l.SetLimit("a", 100)
	l.SetLimit("b", 100)

	err := l.Apply([]Op{
		{Subject: "a", Amount: 60},
		{Subject: "a", Amount: 20, Refund: true}, // valid: 60 -> 40
		{Subject: "a", Amount: 60},               // valid: 40 -> 100
		{Subject: "b", Amount: 7},
	})
	if err != nil {
		t.Fatalf("legal batch rejected: %v", err)
	}
	if got := l.Usage("a"); got != 100 {
		t.Fatalf("a = %d, want 100", got)
	}
	if got := l.Usage("b"); got != 7 {
		t.Fatalf("b = %d, want 7", got)
	}
}

// TestUsageFractionAtLeastExtremes pins cases where a float64 comparison
// gives the wrong answer or where naive uint64 multiplication overflows.
func TestUsageFractionAtLeastExtremes(t *testing.T) {
	cases := []struct {
		name              string
		used, limit, n, d uint64
		want              bool
		floatWouldBeWrong bool
	}{
		// 2^53+3 and 2^54+7 sit exactly between representable float64
		// values and round to 2^53+4 and 2^54+8, so the naive float
		// comparison sees exactly 1/2, while the exact ratio
		// (2^53+3)/(2^54+7) is strictly below 1/2.
		{"below-half-lost-in-float", 1<<53 + 3, 1<<54 + 7, 1, 2, false, true},
		// Products exceed 2^64: (2^64-1)^2 > (2^64-1)(2^64-2), but
		// wrapping uint64 multiplication would compare 1 < 2.
		{"128-bit-product", math.MaxUint64, math.MaxUint64, math.MaxUint64 - 1, math.MaxUint64, true, false},
		{"exact-equality-at-max", math.MaxUint64, math.MaxUint64, math.MaxUint64, math.MaxUint64, true, false},
		{"just-below", 99, 100, 1, 1, false, false},
		{"zero-usage", 0, 100, 1, 100, false, false},
		{"zero-threshold", 0, 100, 0, 1, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := UsageFractionAtLeast(tc.used, tc.limit, tc.n, tc.d); got != tc.want {
				t.Fatalf("UsageFractionAtLeast(%d,%d,%d,%d) = %v, want %v",
					tc.used, tc.limit, tc.n, tc.d, got, tc.want)
			}
			if tc.floatWouldBeWrong {
				naive := float64(tc.used)/float64(tc.limit) >= float64(tc.n)/float64(tc.d)
				if naive == tc.want {
					t.Fatal("test premise broken: float64 comparison unexpectedly correct")
				}
			}
		})
	}
}

// TestUsageFractionAtLeastReference cross-checks the integer comparison
// against an arbitrary-precision big.Int reference on random inputs,
// including values near the uint64 extremes.
func TestUsageFractionAtLeastReference(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	ref := func(used, limit, n, d uint64) bool {
		l := new(big.Int).Mul(new(big.Int).SetUint64(used), new(big.Int).SetUint64(d))
		r := new(big.Int).Mul(new(big.Int).SetUint64(limit), new(big.Int).SetUint64(n))
		return l.Cmp(r) >= 0
	}
	pick := func() uint64 {
		switch rng.Intn(3) {
		case 0:
			return rng.Uint64()
		case 1:
			return math.MaxUint64 - rng.Uint64()%1024
		default:
			return rng.Uint64() % (1 << 20)
		}
	}
	for i := 0; i < 200000; i++ {
		used, limit, n := pick(), pick(), pick()
		d := pick()
		if d == 0 {
			d = 1
		}
		if got, want := UsageFractionAtLeast(used, limit, n, d), ref(used, limit, n, d); got != want {
			t.Fatalf("mismatch at (%d,%d,%d,%d): got %v, big.Int reference %v", used, limit, n, d, got, want)
		}
	}
}

// TestConcurrentConservation releases many goroutines from a barrier that
// hammer the limiter with random batches, then reconciles the final
// counters against an arbitrary-precision reference model built from the
// accepted operations. Conservation: for every subject, and in total,
// sum(charges) - sum(refunds) must equal the final usage exactly.
func TestConcurrentConservation(t *testing.T) {
	const (
		subjects   = 8
		goroutines = 32
		batches    = 500
		limit      = 1 << 40
	)

	l := New()
	names := make([]string, subjects)
	for i := range names {
		names[i] = string(rune('a' + i))
		l.SetLimit(names[i], limit)
	}
	// One subject at the uint64 extreme to exercise overflow paths
	// under concurrency.
	extreme := "extreme"
	l.SetLimit(extreme, math.MaxUint64)
	if err := l.Apply([]Op{{Subject: extreme, Amount: math.MaxUint64 - 1}}); err != nil {
		t.Fatalf("seeding extreme subject: %v", err)
	}
	all := append(append([]string{}, names...), extreme)

	type record struct {
		subject string
		delta   *big.Int // signed: +charge, -refund
	}
	accepted := make([][]record, goroutines)

	var start sync.WaitGroup
	start.Add(1)
	var done sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		done.Add(1)
		go func(g int) {
			defer done.Done()
			rng := rand.New(rand.NewSource(int64(g) + 42))
			start.Wait() // barrier: all goroutines released together
			for b := 0; b < batches; b++ {
				n := 1 + rng.Intn(4)
				batch := make([]Op, n)
				for i := range batch {
					subject := all[rng.Intn(len(all))]
					amount := rng.Uint64() % (1 << 20)
					if rng.Intn(50) == 0 {
						amount = math.MaxUint64 // force overflow rejections
					}
					batch[i] = Op{Subject: subject, Amount: amount, Refund: rng.Intn(2) == 0}
				}
				if err := l.Apply(batch); err != nil {
					continue // rejected batch: no state change, nothing to record
				}
				for _, op := range batch {
					d := new(big.Int).SetUint64(op.Amount)
					if op.Refund {
						d.Neg(d)
					}
					accepted[g] = append(accepted[g], record{op.Subject, d})
				}
			}
		}(g)
	}
	start.Done() // release the barrier
	done.Wait()

	// Arbitrary-precision reference model: replay accepted ops.
	ref := make(map[string]*big.Int, len(all))
	for _, s := range all {
		ref[s] = new(big.Int)
	}
	for _, recs := range accepted {
		for _, r := range recs {
			ref[r.subject].Add(ref[r.subject], r.delta)
		}
	}
	ref[extreme].Add(ref[extreme], new(big.Int).SetUint64(math.MaxUint64-1)) // seed

	total := new(big.Int)
	for _, s := range all {
		got := new(big.Int).SetUint64(l.Usage(s))
		if got.Cmp(ref[s]) != 0 {
			t.Fatalf("subject %s: usage %s, reference model %s", s, got, ref[s])
		}
		if sign := ref[s].Sign(); sign < 0 {
			t.Fatalf("subject %s: negative reference balance %s", s, ref[s])
		}
		if s != extreme && l.Usage(s) > limit {
			t.Fatalf("subject %s: usage %d exceeds limit %d", s, l.Usage(s), limit)
		}
		total.Add(total, got)
	}
	t.Logf("conserved total across %d subjects: %s", len(all), total)
}
