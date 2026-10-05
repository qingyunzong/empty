package quota

import (
	"errors"
	"math/big"
	"math/rand/v2"
	"sync"
	"testing"
)

const maxU64 = ^uint64(0)

func TestIncrementOverflowRejectsWholeBatch(t *testing.T) {
	l := NewLedger()
	if err := l.Apply([]Op{{Subject: "a", Kind: Increment, Amount: maxU64}}); err != nil {
		t.Fatalf("setup: %v", err)
	}
	err := l.Apply([]Op{
		{Subject: "a", Kind: Increment, Amount: 1}, // overflows
		{Subject: "b", Kind: Increment, Amount: 7}, // valid on its own
	})
	var of *OverflowError
	if !errors.As(err, &of) {
		t.Fatalf("want OverflowError, got %v", err)
	}
	if got := l.Balance("a"); got != maxU64 {
		t.Fatalf("a changed after rejected batch: %d", got)
	}
	if got := l.Balance("b"); got != 0 {
		t.Fatalf("b committed despite rejected batch: %d", got)
	}
}

func TestRefundUnderflowRejectsWholeBatch(t *testing.T) {
	l := NewLedger()
	if err := l.Apply([]Op{{Subject: "a", Kind: Increment, Amount: 5}}); err != nil {
		t.Fatalf("setup: %v", err)
	}
	err := l.Apply([]Op{
		{Subject: "b", Kind: Increment, Amount: 100},
		{Subject: "a", Kind: Refund, Amount: 6}, // underflows
	})
	var uf *UnderflowError
	if !errors.As(err, &uf) {
		t.Fatalf("want UnderflowError, got %v", err)
	}
	if got := l.Balance("a"); got != 5 {
		t.Fatalf("a changed after rejected batch: %d", got)
	}
	if got := l.Balance("b"); got != 0 {
		t.Fatalf("b committed despite rejected batch: %d", got)
	}
}

func TestBoundaryOpsSucceed(t *testing.T) {
	l := NewLedger()
	if err := l.Apply([]Op{{Subject: "a", Kind: Increment, Amount: maxU64}}); err != nil {
		t.Fatalf("increment to MaxUint64: %v", err)
	}
	if err := l.Apply([]Op{{Subject: "a", Kind: Refund, Amount: maxU64}}); err != nil {
		t.Fatalf("refund of full balance: %v", err)
	}
	if got := l.Balance("a"); got != 0 {
		t.Fatalf("balance = %d, want 0", got)
	}
	if err := l.Apply([]Op{{Subject: "z", Kind: Refund, Amount: 0}}); err != nil {
		t.Fatalf("zero refund on missing subject: %v", err)
	}
}

func TestBatchChainsWithinBatch(t *testing.T) {
	l := NewLedger()
	// Ops against the same subject must see the effects of earlier ops
	// in the same batch during validation.
	err := l.Apply([]Op{
		{Subject: "a", Kind: Increment, Amount: 10},
		{Subject: "a", Kind: Refund, Amount: 10},
	})
	if err != nil {
		t.Fatalf("chained batch: %v", err)
	}
	err = l.Apply([]Op{
		{Subject: "a", Kind: Refund, Amount: 1}, // underflows: balance is 0
	})
	var uf *UnderflowError
	if !errors.As(err, &uf) {
		t.Fatalf("want UnderflowError, got %v", err)
	}
}

func TestThresholdComparisonIsExact(t *testing.T) {
	l := NewLedger()
	// 2^53 and 2^53+1 are indistinguishable as float64; integer
	// comparison must tell them apart.
	const two53 = uint64(1) << 53
	if err := l.Apply([]Op{{Subject: "a", Kind: Increment, Amount: two53 + 1}}); err != nil {
		t.Fatalf("setup: %v", err)
	}
	if got := l.CompareThreshold("a", two53+1); got != 0 {
		t.Fatalf("CompareThreshold(equal) = %d, want 0", got)
	}
	if got := l.CompareThreshold("a", two53); got != 1 {
		t.Fatalf("CompareThreshold(below) = %d, want 1", got)
	}
	if !l.AtLeast("a", two53+1) || l.AtLeast("a", two53+2) {
		t.Fatal("AtLeast wrong around 2^53 boundary")
	}
	if err := l.Apply([]Op{{Subject: "m", Kind: Increment, Amount: maxU64}}); err != nil {
		t.Fatalf("setup: %v", err)
	}
	if !l.AtLeast("m", maxU64) || l.CompareThreshold("m", maxU64-1) != 1 {
		t.Fatal("threshold comparison wrong at MaxUint64")
	}
}

func TestInvalidKindRejected(t *testing.T) {
	l := NewLedger()
	err := l.Apply([]Op{{Subject: "a", Kind: Kind(42), Amount: 1}})
	if !errors.Is(err, ErrInvalidKind) {
		t.Fatalf("want ErrInvalidKind, got %v", err)
	}
	if got := l.Balance("a"); got != 0 {
		t.Fatalf("ledger mutated: %d", got)
	}
}

// TestConcurrentBarrier launches goroutines behind a start barrier so
// they contend maximally, then checks the exact final balances.
func TestConcurrentBarrier(t *testing.T) {
	l := NewLedger()
	const workers = 64
	const perWorker = 500

	var ready, done sync.WaitGroup
	ready.Add(workers)
	done.Add(workers)
	start := make(chan struct{})
	for w := 0; w < workers; w++ {
		go func(w int) {
			defer done.Done()
			ready.Done()
			<-start // barrier: all goroutines released together
			for i := 0; i < perWorker; i++ {
				if err := l.Apply([]Op{{Subject: "shared", Kind: Increment, Amount: 1}}); err != nil {
					t.Errorf("increment: %v", err)
					return
				}
				if err := l.Apply([]Op{{Subject: "shared", Kind: Refund, Amount: 1}}); err != nil {
					t.Errorf("refund: %v", err)
					return
				}
			}
			// Leave a non-zero residue to verify the exact total.
			if err := l.Apply([]Op{{Subject: "shared", Kind: Increment, Amount: uint64(w + 1)}}); err != nil {
				t.Errorf("residue: %v", err)
			}
		}(w)
	}
	ready.Wait()
	close(start)
	done.Wait()

	want := uint64(0)
	for w := 0; w < workers; w++ {
		want += uint64(w + 1)
	}
	if got := l.Balance("shared"); got != want {
		t.Fatalf("balance = %d, want %d", got, want)
	}
}

// bigModel is an arbitrary-precision reference model of the ledger.
type bigModel struct {
	balances map[string]*big.Int
	max      *big.Int
}

func newBigModel() *bigModel {
	m := &bigModel{balances: make(map[string]*big.Int), max: new(big.Int)}
	m.max.SetUint64(maxU64)
	return m
}

func (m *bigModel) get(subject string) *big.Int {
	if v, ok := m.balances[subject]; ok {
		return new(big.Int).Set(v)
	}
	return new(big.Int)
}

// apply mirrors Ledger.Apply: validate the whole batch with big.Int
// arithmetic, commit only if every op stays within [0, MaxUint64].
func (m *bigModel) apply(ops []Op) bool {
	next := make(map[string]*big.Int, len(ops))
	for _, op := range ops {
		cur, ok := next[op.Subject]
		if !ok {
			cur = m.get(op.Subject)
		}
		var nxt *big.Int
		switch op.Kind {
		case Increment:
			nxt = new(big.Int).Add(cur, new(big.Int).SetUint64(op.Amount))
			if nxt.Cmp(m.max) > 0 {
				return false
			}
		case Refund:
			nxt = new(big.Int).Sub(cur, new(big.Int).SetUint64(op.Amount))
			if nxt.Sign() < 0 {
				return false
			}
		default:
			return false
		}
		next[op.Subject] = nxt
	}
	for subject, v := range next {
		m.balances[subject] = v
	}
	return true
}

// TestAgainstBigIntReferenceModel drives the ledger and a big.Int model
// through identical randomized batches (including extreme amounts) and
// checks state equality plus conservation after every step.
func TestAgainstBigIntReferenceModel(t *testing.T) {
	l := NewLedger()
	model := newBigModel()
	rng := rand.New(rand.NewPCG(1, 2))

	subjects := []string{"alpha", "beta", "gamma", "delta"}
	// totalIn - totalRefund must equal the sum of all balances.
	totalIn := new(big.Int)
	totalRefund := new(big.Int)

	extremes := []uint64{0, 1, 2, maxU64, maxU64 - 1, maxU64 / 2, uint64(1) << 53, (uint64(1) << 53) + 1}
	amount := func() uint64 {
		if rng.UintN(2) == 0 {
			return extremes[rng.UintN(uint(len(extremes)))]
		}
		return rng.Uint64()
	}

	for step := 0; step < 3000; step++ {
		n := 1 + rng.UintN(4)
		ops := make([]Op, n)
		for i := range ops {
			kind := Increment
			if rng.UintN(2) == 0 {
				kind = Refund
			}
			ops[i] = Op{Subject: subjects[rng.UintN(uint(len(subjects)))], Kind: kind, Amount: amount()}
		}

		modelOK := model.apply(ops)
		ledgerErr := l.Apply(ops)
		if (ledgerErr == nil) != modelOK {
			t.Fatalf("step %d: model accepted=%v, ledger err=%v, ops=%+v", step, modelOK, ledgerErr, ops)
		}
		if ledgerErr != nil {
			continue // rejected batch: no state change on either side
		}
		for _, op := range ops {
			switch op.Kind {
			case Increment:
				totalIn.Add(totalIn, new(big.Int).SetUint64(op.Amount))
			case Refund:
				totalRefund.Add(totalRefund, new(big.Int).SetUint64(op.Amount))
			}
		}
		for _, s := range subjects {
			want := model.get(s)
			if !want.IsUint64() {
				t.Fatalf("step %d: model balance for %q out of uint64 range: %s", step, s, want)
			}
			if got := l.Balance(s); got != want.Uint64() {
				t.Fatalf("step %d: balance[%q] = %d, model says %d", step, s, got, want)
			}
		}
	}

	// Conservation: sum of balances == total increments - total refunds.
	sum := new(big.Int)
	for _, s := range subjects {
		sum.Add(sum, model.get(s))
	}
	conserved := new(big.Int).Sub(totalIn, totalRefund)
	if sum.Cmp(conserved) != 0 {
		t.Fatalf("conservation violated: balances sum %s, in-out %s", sum, conserved)
	}
	t.Logf("final: in=%s out=%s sum=%s", totalIn, totalRefund, sum)
}
