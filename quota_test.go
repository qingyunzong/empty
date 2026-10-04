package quota

import (
	"errors"
	"fmt"
	"sync"
	"testing"
)

func TestTransferAtomic(t *testing.T) {
	l := NewLedger()
	mustOpen(t, l, "a", 100)
	mustOpen(t, l, "b", 0)

	r, err := l.Transfer("k1", "a", "b", 30)
	if err != nil {
		t.Fatalf("transfer: %v", err)
	}
	if r.FromBal != 70 || r.ToBal != 30 {
		t.Fatalf("receipt balances = %d/%d, want 70/30", r.FromBal, r.ToBal)
	}
	if got, _ := l.Balance("a"); got != 70 {
		t.Fatalf("a balance = %d, want 70", got)
	}
	if got, _ := l.Balance("b"); got != 30 {
		t.Fatalf("b balance = %d, want 30", got)
	}
	if l.Total() != 100 {
		t.Fatalf("total = %d, want 100", l.Total())
	}
}

func TestBatchAcrossThreeAccountsAllOrNothing(t *testing.T) {
	l := NewLedger()
	mustOpen(t, l, "a", 100)
	mustOpen(t, l, "b", 50)
	mustOpen(t, l, "c", 10)

	before := map[string]int64{"a": 100, "b": 50, "c": 10}

	// a and c both debit into b, but c cannot cover its share.
	_, err := l.TransferBatch("batch1", []Transfer{
		{From: "a", To: "b", Amount: 40},
		{From: "c", To: "b", Amount: 20},
		{From: "b", To: "a", Amount: 5},
	})
	if !errors.Is(err, ErrInsufficientFunds) {
		t.Fatalf("err = %v, want ErrInsufficientFunds", err)
	}
	for acc, want := range before {
		if got, _ := l.Balance(acc); got != want {
			t.Fatalf("%s balance = %d, want %d (no partial changes allowed)", acc, got, want)
		}
	}
	if n := len(l.History()); n != 0 {
		t.Fatalf("history len = %d, want 0 after failed batch", n)
	}

	// A valid three-account batch applies fully.
	receipts, err := l.TransferBatch("batch2", []Transfer{
		{From: "a", To: "b", Amount: 40},
		{From: "c", To: "b", Amount: 10},
		{From: "b", To: "a", Amount: 5},
	})
	if err != nil {
		t.Fatalf("batch2: %v", err)
	}
	if len(receipts) != 3 {
		t.Fatalf("receipts = %d, want 3", len(receipts))
	}
	want := map[string]int64{"a": 65, "b": 95, "c": 0}
	for acc, w := range want {
		if got, _ := l.Balance(acc); got != w {
			t.Fatalf("%s balance = %d, want %d", acc, got, w)
		}
	}
	if l.Total() != 160 {
		t.Fatalf("total = %d, want 160", l.Total())
	}
}

func TestIdempotentReplayReturnsStoredResult(t *testing.T) {
	l := NewLedger()
	mustOpen(t, l, "a", 100)
	mustOpen(t, l, "b", 0)

	first, err := l.Transfer("k", "a", "b", 25)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	second, err := l.Transfer("k", "a", "b", 25)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if first != second {
		t.Fatalf("replay receipt %+v != first %+v", second, first)
	}
	if got, _ := l.Balance("a"); got != 75 {
		t.Fatalf("a balance = %d, want 75 (replay must not double-apply)", got)
	}
	if n := len(l.History()); n != 1 {
		t.Fatalf("history len = %d, want 1", n)
	}
}

func TestIdempotencyKeyConflict(t *testing.T) {
	l := NewLedger()
	mustOpen(t, l, "a", 100)
	mustOpen(t, l, "b", 0)
	mustOpen(t, l, "c", 0)

	if _, err := l.Transfer("k", "a", "b", 25); err != nil {
		t.Fatalf("first: %v", err)
	}
	if _, err := l.Transfer("k", "a", "b", 26); !errors.Is(err, ErrConflict) {
		t.Fatalf("different amount: err = %v, want ErrConflict", err)
	}
	if _, err := l.Transfer("k", "a", "c", 25); !errors.Is(err, ErrConflict) {
		t.Fatalf("different target: err = %v, want ErrConflict", err)
	}
	if _, err := l.TransferBatch("k", []Transfer{
		{From: "a", To: "b", Amount: 25},
		{From: "a", To: "c", Amount: 1},
	}); !errors.Is(err, ErrConflict) {
		t.Fatalf("different batch shape: err = %v, want ErrConflict", err)
	}
	if got, _ := l.Balance("a"); got != 75 {
		t.Fatalf("a balance = %d, want 75 (conflicts must not apply)", got)
	}
}

func TestConcurrentBarrierAndSerialHistoryCheck(t *testing.T) {
	const (
		accounts   = 8
		workers    = 16
		perWorker  = 50
		initialBal = 1000
	)
	l := NewLedger()
	for i := 0; i < accounts; i++ {
		mustOpen(t, l, fmt.Sprintf("acc%d", i), initialBal)
	}
	wantTotal := int64(accounts * initialBal)

	type outcome struct {
		receipts []Receipt
		err      error
	}
	results := make([]outcome, workers)
	var wg sync.WaitGroup
	barrier := make(chan struct{})
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			<-barrier // all goroutines released simultaneously
			var receipts []Receipt
			for i := 0; i < perWorker; i++ {
				from := fmt.Sprintf("acc%d", (w+i)%accounts)
				to := fmt.Sprintf("acc%d", (w+i+1)%accounts)
				key := fmt.Sprintf("w%d-i%d", w, i)
				r, err := l.Transfer(key, from, to, 1)
				if err != nil && !errors.Is(err, ErrInsufficientFunds) {
					results[w] = outcome{err: err}
					return
				}
				if err == nil {
					receipts = append(receipts, r)
				}
			}
			results[w] = outcome{receipts: receipts}
		}(w)
	}
	close(barrier)
	wg.Wait()

	for w, res := range results {
		if res.err != nil {
			t.Fatalf("worker %d: unexpected error %v", w, res.err)
		}
	}

	// Total is conserved no matter how transfers interleaved.
	if got := l.Total(); got != wantTotal {
		t.Fatalf("total = %d, want %d", got, wantTotal)
	}

	// Serially replay the committed history from the initial balances:
	// every entry's recorded post-balances must match the replay, and
	// no balance may ever go negative.
	history := l.History()
	replay := make(map[string]int64)
	for i := 0; i < accounts; i++ {
		replay[fmt.Sprintf("acc%d", i)] = initialBal
	}
	for idx, e := range history {
		if e.Seq != uint64(idx+1) {
			t.Fatalf("entry %d seq = %d, want %d (history must be gapless)", idx, e.Seq, idx+1)
		}
		replay[e.From] -= e.Amount
		replay[e.To] += e.Amount
		if replay[e.From] != e.FromBal || replay[e.To] != e.ToBal {
			t.Fatalf("entry %d (%s->%s %d): recorded %d/%d, replay %d/%d",
				e.Seq, e.From, e.To, e.Amount, e.FromBal, e.ToBal, replay[e.From], replay[e.To])
		}
		if e.FromBal < 0 {
			t.Fatalf("entry %d: negative balance %d", e.Seq, e.FromBal)
		}
	}
	// Replay must converge to the live balances.
	for acc, want := range replay {
		if got, _ := l.Balance(acc); got != want {
			t.Fatalf("final %s balance = %d, replay says %d", acc, got, want)
		}
	}

	// Every receipt returned to a worker must be found in the history
	// with identical contents, and each history entry is claimed once.
	bySeq := make(map[uint64]Entry, len(history))
	for _, e := range history {
		bySeq[e.Seq] = e
	}
	claimed := make(map[uint64]bool)
	for w, res := range results {
		for _, r := range res.receipts {
			e, ok := bySeq[r.Seq]
			if !ok {
				t.Fatalf("worker %d: receipt seq %d missing from history", w, r.Seq)
			}
			if claimed[r.Seq] {
				t.Fatalf("worker %d: seq %d returned to two workers", w, r.Seq)
			}
			claimed[r.Seq] = true
			if e.From != r.From || e.To != r.To || e.Amount != r.Amount ||
				e.FromBal != r.FromBal || e.ToBal != r.ToBal {
				t.Fatalf("worker %d: receipt %+v mismatches history %+v", w, r, e)
			}
		}
	}
	if len(claimed) != len(history) {
		t.Fatalf("history entries = %d, receipts claimed = %d", len(history), len(claimed))
	}
}

func TestConcurrentDuplicateKey(t *testing.T) {
	l := NewLedger()
	mustOpen(t, l, "a", 100)
	mustOpen(t, l, "b", 0)

	const workers = 32
	receipts := make([]Receipt, workers)
	errs := make([]error, workers)
	var wg sync.WaitGroup
	barrier := make(chan struct{})
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			<-barrier
			receipts[w], errs[w] = l.Transfer("same-key", "a", "b", 5)
		}(w)
	}
	close(barrier)
	wg.Wait()

	for w := 0; w < workers; w++ {
		if errs[w] != nil {
			t.Fatalf("worker %d: %v", w, errs[w])
		}
		if receipts[w] != receipts[0] {
			t.Fatalf("worker %d receipt %+v != worker 0 %+v", w, receipts[w], receipts[0])
		}
	}
	if got, _ := l.Balance("a"); got != 95 {
		t.Fatalf("a balance = %d, want 95 (key applied exactly once)", got)
	}
	if n := len(l.History()); n != 1 {
		t.Fatalf("history len = %d, want 1", n)
	}
}

func TestConcurrentConflictingKey(t *testing.T) {
	l := NewLedger()
	mustOpen(t, l, "a", 1000)
	mustOpen(t, l, "b", 0)

	const workers = 32
	errs := make([]error, workers)
	var wg sync.WaitGroup
	barrier := make(chan struct{})
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			<-barrier
			// Worker 0 uses amount 1, everyone else uses amount 2.
			amount := int64(2)
			if w == 0 {
				amount = 1
			}
			_, errs[w] = l.Transfer("hot-key", "a", "b", amount)
		}(w)
	}
	close(barrier)
	wg.Wait()

	// Exactly one parameter set wins the key; goroutines replaying the
	// winning parameters succeed, everyone else gets ErrConflict.
	var successes, conflicts int
	for _, err := range errs {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrConflict):
			conflicts++
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}
	soloWinner := successes == 1 && conflicts == workers-1
	groupWinner := successes == workers-1 && conflicts == 1
	if !soloWinner && !groupWinner {
		t.Fatalf("successes = %d, conflicts = %d, want one parameter set to win", successes, conflicts)
	}
	if n := len(l.History()); n != 1 {
		t.Fatalf("history len = %d, want 1", n)
	}
}

func mustOpen(t *testing.T, l *Ledger, account string, balance int64) {
	t.Helper()
	if err := l.Open(account, balance); err != nil {
		t.Fatalf("open %s: %v", account, err)
	}
}
