package quota

import (
	"errors"
	"fmt"
	"sync"
	"testing"
)

func mustLedger(t *testing.T, initial map[string]int64) *Ledger {
	t.Helper()
	l, err := NewLedger(initial)
	if err != nil {
		t.Fatalf("NewLedger: %v", err)
	}
	return l
}

func TestTransferAtomic(t *testing.T) {
	l := mustLedger(t, map[string]int64{"a": 100, "b": 0})

	res, err := l.Transfer("k1", "a", "b", 40)
	if err != nil {
		t.Fatalf("Transfer: %v", err)
	}
	if res.Replayed {
		t.Fatal("first call must not be a replay")
	}
	if res.FromBalance != 60 || res.ToBalance != 40 {
		t.Fatalf("unexpected balances in result: %+v", res)
	}
	if got, _ := l.Balance("a"); got != 60 {
		t.Fatalf("a balance = %d, want 60", got)
	}
	if got, _ := l.Balance("b"); got != 40 {
		t.Fatalf("b balance = %d, want 40", got)
	}
	if l.Total() != 100 {
		t.Fatalf("total = %d, want 100", l.Total())
	}

	if _, err := l.Transfer("k2", "a", "b", 1000); !errors.Is(err, ErrInsufficientFunds) {
		t.Fatalf("expected ErrInsufficientFunds, got %v", err)
	}
	if got, _ := l.Balance("a"); got != 60 {
		t.Fatalf("failed transfer mutated balance: a = %d", got)
	}
	if len(l.History()) != 1 {
		t.Fatalf("failed transfer recorded history")
	}
}

func TestBatchThreeAccountsAllOrNothing(t *testing.T) {
	initial := map[string]int64{"a": 100, "b": 50, "c": 0}
	l := mustLedger(t, initial)

	// The third op overdraws b after the second op: the whole batch must fail.
	_, err := l.BatchTransfer("batch-fail", []Op{
		{From: "a", To: "b", Amount: 60},
		{From: "b", To: "c", Amount: 100},
		{From: "b", To: "a", Amount: 20},
	})
	if !errors.Is(err, ErrInsufficientFunds) {
		t.Fatalf("expected ErrInsufficientFunds, got %v", err)
	}
	for acct, want := range initial {
		if got, _ := l.Balance(acct); got != want {
			t.Fatalf("failed batch mutated %s: got %d, want %d", acct, got, want)
		}
	}
	if len(l.History()) != 0 {
		t.Fatalf("failed batch recorded history")
	}

	// A valid three-account cycle applies atomically.
	results, err := l.BatchTransfer("batch-ok", []Op{
		{From: "a", To: "b", Amount: 60},
		{From: "b", To: "c", Amount: 100},
		{From: "c", To: "a", Amount: 30},
	})
	if err != nil {
		t.Fatalf("BatchTransfer: %v", err)
	}
	wantBalances := map[string]int64{"a": 70, "b": 10, "c": 70}
	for acct, want := range wantBalances {
		if got, _ := l.Balance(acct); got != want {
			t.Fatalf("%s balance = %d, want %d", acct, got, want)
		}
	}
	if l.Total() != 150 {
		t.Fatalf("total = %d, want 150", l.Total())
	}
	if len(results) != 3 || results[0].FromBalance != 40 || results[1].FromBalance != 10 || results[2].ToBalance != 70 {
		t.Fatalf("unexpected batch results: %+v", results)
	}
}

func TestIdempotencyReplayAndConflict(t *testing.T) {
	l := mustLedger(t, map[string]int64{"a": 100, "b": 0})

	first, err := l.Transfer("key-1", "a", "b", 25)
	if err != nil {
		t.Fatalf("Transfer: %v", err)
	}
	second, err := l.Transfer("key-1", "a", "b", 25)
	if err != nil {
		t.Fatalf("replay returned error: %v", err)
	}
	if !second.Replayed {
		t.Fatal("duplicate key with identical parameters must replay")
	}
	second.Replayed = false
	if first != second {
		t.Fatalf("replayed result differs: %+v vs %+v", first, second)
	}
	if got, _ := l.Balance("a"); got != 75 {
		t.Fatalf("replay double-applied: a = %d, want 75", got)
	}
	if len(l.History()) != 1 {
		t.Fatalf("replay appended history")
	}

	// Same key, different amount: conflict.
	if _, err := l.Transfer("key-1", "a", "b", 26); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("expected ErrIdempotencyConflict, got %v", err)
	}
	// Same key, different accounts: conflict.
	if _, err := l.Transfer("key-1", "b", "a", 25); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("expected ErrIdempotencyConflict, got %v", err)
	}
	// Same key, single op vs batch: conflict.
	_, err = l.BatchTransfer("key-1", []Op{{From: "a", To: "b", Amount: 25}, {From: "a", To: "b", Amount: 1}})
	if !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("expected ErrIdempotencyConflict, got %v", err)
	}
	if got, _ := l.Balance("a"); got != 75 {
		t.Fatalf("conflict mutated balance: a = %d", got)
	}
}

func TestConcurrentIdempotentRetry(t *testing.T) {
	l := mustLedger(t, map[string]int64{"a": 1000, "b": 0})

	const goroutines = 16
	start := make(chan struct{})
	results := make([]TransferResult, goroutines)
	errs := make([]error, goroutines)
	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			results[i], errs[i] = l.Transfer("shared-key", "a", "b", 10)
		}(i)
	}
	close(start)
	wg.Wait()

	applied := 0
	for i := 0; i < goroutines; i++ {
		if errs[i] != nil {
			t.Fatalf("goroutine %d: %v", i, errs[i])
		}
		if results[i].Replayed {
			continue
		}
		applied++
		want := results[i]
		want.Replayed = true
		for j := 0; j < goroutines; j++ {
			if results[j].Replayed && results[j] != want {
				t.Fatalf("replayed result %d differs from applied result", j)
			}
		}
	}
	if applied != 1 {
		t.Fatalf("applied %d times, want exactly 1", applied)
	}
	if got, _ := l.Balance("a"); got != 990 {
		t.Fatalf("a = %d, want 990 (applied exactly once)", got)
	}
	if len(l.History()) != 1 {
		t.Fatalf("history len = %d, want 1", len(l.History()))
	}
}

// TestConcurrentBarrierAndSerialHistory hammers the ledger from many
// goroutines released by a barrier, then verifies the conserved total and
// replays the serial history to check every returned result.
func TestConcurrentBarrierAndSerialHistory(t *testing.T) {
	const (
		accounts   = 8
		goroutines = 32
		iterations = 50
	)
	initial := make(map[string]int64, accounts)
	names := make([]string, accounts)
	var initialTotal int64
	for i := 0; i < accounts; i++ {
		names[i] = fmt.Sprintf("acct-%d", i)
		initial[names[i]] = 1_000_000
		initialTotal += 1_000_000
	}
	l := mustLedger(t, initial)

	type outcome struct {
		results []TransferResult
		err     error
	}
	outcomes := make([]outcome, goroutines)

	start := make(chan struct{})
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			<-start // barrier: all goroutines release together
			var all []TransferResult
			for i := 0; i < iterations; i++ {
				// Deterministic pseudo-random three-account batch.
				seed := g*iterations + i
				a := names[seed%accounts]
				b := names[(seed*7+3)%accounts]
				c := names[(seed*13+5)%accounts]
				if a == b || b == c || a == c {
					continue
				}
				key := fmt.Sprintf("g%d-i%d", g, i)
				results, err := l.BatchTransfer(key, []Op{
					{From: a, To: b, Amount: int64(seed%9 + 1)},
					{From: b, To: c, Amount: int64(seed%5 + 1)},
					{From: c, To: a, Amount: int64(seed%3 + 1)},
				})
				if err != nil {
					outcomes[g] = outcome{err: err}
					return
				}
				all = append(all, results...)
			}
			outcomes[g] = outcome{results: all}
		}(g)
	}
	close(start)
	wg.Wait()

	// Every batch succeeded and every result is a fresh (non-replayed) apply.
	returned := make(map[int64][]TransferResult) // seq -> results returned to callers
	for g, o := range outcomes {
		if o.err != nil {
			t.Fatalf("goroutine %d: %v", g, o.err)
		}
		for _, r := range o.results {
			if r.Replayed {
				t.Fatalf("goroutine %d got unexpected replay", g)
			}
			returned[r.Seq] = append(returned[r.Seq], r)
		}
	}

	// Total quota is conserved across all concurrent batches.
	if got := l.Total(); got != initialTotal {
		t.Fatalf("total = %d, want %d", got, initialTotal)
	}

	// Serial history search: replay the append-only history from the initial
	// state and check every recorded (and returned) result, in order.
	history := l.History()
	if len(history) != len(returned) {
		t.Fatalf("history has %d batches, callers saw %d", len(history), len(returned))
	}
	shadow := make(map[string]int64, len(initial))
	for acct, bal := range initial {
		shadow[acct] = bal
	}
	for i, entry := range history {
		if entry.Seq != int64(i+1) {
			t.Fatalf("history seq gap at %d: got %d", i, entry.Seq)
		}
		if len(entry.Ops) != len(entry.Results) {
			t.Fatalf("entry %d: %d ops but %d results", entry.Seq, len(entry.Ops), len(entry.Results))
		}
		for j, op := range entry.Ops {
			shadow[op.From] -= op.Amount
			shadow[op.To] += op.Amount
			r := entry.Results[j]
			if r.FromBalance != shadow[op.From] || r.ToBalance != shadow[op.To] {
				t.Fatalf("entry %d op %d: recorded balances (%d,%d), serial replay gives (%d,%d)",
					entry.Seq, j, r.FromBalance, r.ToBalance, shadow[op.From], shadow[op.To])
			}
		}
		// Each returned result must match the serial history exactly.
		got := returned[entry.Seq]
		if len(got) != len(entry.Results) {
			t.Fatalf("entry %d: callers got %d results, history has %d", entry.Seq, len(got), len(entry.Results))
		}
		for j := range got {
			if got[j] != entry.Results[j] {
				t.Fatalf("entry %d op %d: returned %+v, history %+v", entry.Seq, j, got[j], entry.Results[j])
			}
		}
	}
	// Serial replay must converge to the live balances.
	for acct, want := range shadow {
		if got, _ := l.Balance(acct); got != want {
			t.Fatalf("%s: live %d, serial replay %d", acct, got, want)
		}
	}
}
