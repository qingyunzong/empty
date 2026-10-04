package liability

import (
	"math/rand"
	"sort"
	"testing"
)

func borrow(seq uint64, t, amt int64) Event {
	return Event{Seq: seq, Time: t, Kind: KindBorrow, Amount: amt}
}

func repay(seq uint64, t, amt int64) Event {
	return Event{Seq: seq, Time: t, Kind: KindRepay, Amount: amt}
}

func reverse(seq uint64, t int64, target uint64) Event {
	return Event{Seq: seq, Time: t, Kind: KindReverse, Target: target}
}

func ledgerOf(evs ...Event) *Ledger {
	l := NewLedger()
	l.AddBatch(evs)
	return l
}

func TestMaxLiabilityBasic(t *testing.T) {
	l := ledgerOf(
		borrow(1, 10, 100),
		borrow(2, 20, 50),
		repay(3, 30, 120),
		borrow(4, 40, 10),
	)
	// Balances: t10=100, t20=150, t30=30, t40=40.
	if got, at := l.MaxLiability(0, 100); got != 150 || at != 20 {
		t.Fatalf("full range: got (%d, %d), want (150, 20)", got, at)
	}
	// Opening balance 150 (carried from t20) dominates the interval.
	if got, at := l.MaxLiability(25, 100); got != 150 || at != 25 {
		t.Fatalf("tail range: got (%d, %d), want (150, 25)", got, at)
	}
}

func TestMaxLiabilityCrossesQueryBoundary(t *testing.T) {
	l := ledgerOf(
		borrow(1, 1, 500),
		repay(2, 2, 100),
		repay(3, 100, 50),
	)
	// Opening balance inside [50, 200) is 400 carried from before the
	// interval; the max is the opening balance reported at time `from`.
	if got, at := l.MaxLiability(50, 200); got != 400 || at != 50 {
		t.Fatalf("got (%d, %d), want (400, 50)", got, at)
	}
	// No events inside the interval at all: still the carried balance.
	if got, at := l.MaxLiability(3, 99); got != 400 || at != 3 {
		t.Fatalf("got (%d, %d), want (400, 3)", got, at)
	}
}

func TestEarliestTimeWins(t *testing.T) {
	l := ledgerOf(
		borrow(1, 10, 70),
		repay(2, 20, 20),
		borrow(3, 30, 20), // back to 70, later than t10
	)
	if got, at := l.MaxLiability(0, 100); got != 70 || at != 10 {
		t.Fatalf("got (%d, %d), want (70, 10)", got, at)
	}
}

func TestIllegalOverpaymentHasNoEffect(t *testing.T) {
	l := ledgerOf(
		borrow(1, 1, 100),
		repay(2, 2, 150), // illegal: exceeds balance, ignored
		repay(3, 3, 0),   // non-positive: ignored
		repay(4, 4, 60),  // legal
	)
	if got := l.BalanceAt(100); got != 40 {
		t.Fatalf("balance: got %d, want 40", got)
	}
	if got, at := l.MaxLiability(0, 100); got != 100 || at != 1 {
		t.Fatalf("got (%d, %d), want (100, 1)", got, at)
	}
}

func TestReversals(t *testing.T) {
	l := ledgerOf(
		borrow(1, 1, 100),
		repay(2, 2, 30),
		reverse(3, 3, 2), // undo repay: 70 -> 100
		reverse(4, 4, 1), // undo borrow: 100 -> 0
		reverse(5, 5, 1), // already reversed: no-op
		reverse(6, 6, 2), // reversing a reversed repay: no-op
		reverse(7, 7, 9), // unknown target: no-op
		reverse(8, 8, 3), // reversing a reversal: no-op
	)
	if got := l.BalanceAt(100); got != 0 {
		t.Fatalf("balance: got %d, want 0", got)
	}
	if got, at := l.MaxLiability(0, 100); got != 100 || at != 1 {
		t.Fatalf("got (%d, %d), want (100, 1)", got, at)
	}
}

func TestReverseOfIneffectiveEventIsNoOp(t *testing.T) {
	l := ledgerOf(
		borrow(1, 1, 50),
		repay(2, 2, 80),   // illegal overpayment, never took effect
		reverse(3, 3, 2),  // nothing to undo
		borrow(4, 4, 200), // balance 250
		reverse(5, 5, 4),  // undo borrow of 200: 250 -> 50
		borrow(6, 6, 10),
		repay(7, 7, 55),  // 60 -> 5
		reverse(8, 8, 6), // undo borrow of 10: 5 < 10, illegal, no-op
	)
	if got := l.BalanceAt(100); got != 5 {
		t.Fatalf("balance: got %d, want 5", got)
	}
}

func TestOutOfOrderAndSameTimeOrdering(t *testing.T) {
	l := NewLedger()
	// Inserted out of order; same timestamp resolves by Seq.
	l.Add(repay(3, 10, 40))
	l.Add(borrow(1, 10, 100))
	l.Add(borrow(2, 10, 60))
	l.Add(borrow(4, 5, 7))
	// Replay order by (Time, Seq): t5 borrow 7; t10 seq1 +100, seq2 +60,
	// seq3 -40 => final 127.
	if got := l.BalanceAt(100); got != 127 {
		t.Fatalf("balance: got %d, want 127", got)
	}
	if got, at := l.MaxLiability(0, 100); got != 167 || at != 10 {
		t.Fatalf("got (%d, %d), want (167, 10)", got, at)
	}
}

func TestEmptyAndDegenerateIntervals(t *testing.T) {
	l := ledgerOf(borrow(1, 10, 5))
	if got, at := l.MaxLiability(20, 20); got != 0 || at != 20 {
		t.Fatalf("empty interval: got (%d, %d), want (0, 20)", got, at)
	}
	if got, at := NewLedger().MaxLiability(0, 100); got != 0 || at != 0 {
		t.Fatalf("no events: got (%d, %d), want (0, 0)", got, at)
	}
}

// --- Full-replay cross-check ---------------------------------------------
//
// bruteForce is an independent, deliberately naive implementation of the
// same semantics. For every candidate checkpoint it replays the whole
// history from scratch, which is the "complete replay" reference used to
// verify Ledger.MaxLiability on randomized workloads.

func bruteBalanceAt(evs []Event, uptoIdx int) int64 {
	balance := int64(0)
	applied := make(map[uint64]effect)
	reversed := make(map[uint64]bool)
	seen := make(map[uint64]bool)
	for i := 0; i <= uptoIdx; i++ {
		ev := evs[i]
		if seen[ev.Seq] {
			continue
		}
		seen[ev.Seq] = true
		switch ev.Kind {
		case KindBorrow:
			if ev.Amount > 0 {
				balance += ev.Amount
				applied[ev.Seq] = effect{KindBorrow, ev.Amount}
			}
		case KindRepay:
			if ev.Amount > 0 && ev.Amount <= balance {
				balance -= ev.Amount
				applied[ev.Seq] = effect{KindRepay, ev.Amount}
			}
		case KindReverse:
			eff, ok := applied[ev.Target]
			if !ok || reversed[ev.Target] {
				continue
			}
			if eff.kind == KindBorrow {
				if eff.amount > balance {
					continue
				}
				balance -= eff.amount
			} else {
				balance += eff.amount
			}
			reversed[ev.Target] = true
		}
	}
	return balance
}

func bruteMaxLiability(evs []Event, from, to int64) (int64, int64) {
	if to <= from {
		return 0, from
	}
	sorted := append([]Event(nil), evs...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].Time != sorted[j].Time {
			return sorted[i].Time < sorted[j].Time
		}
		return sorted[i].Seq < sorted[j].Seq
	})
	// Opening balance: replay everything strictly before `from`.
	opening := int64(0)
	{
		last := -1
		for i, ev := range sorted {
			if ev.Time < from {
				last = i
			}
		}
		if last >= 0 {
			opening = bruteBalanceAt(sorted, last)
		}
	}
	best, bestTime := opening, from
	for i, ev := range sorted {
		if ev.Time < from || ev.Time >= to {
			continue
		}
		if b := bruteBalanceAt(sorted, i); b > best {
			best, bestTime = b, ev.Time
		}
	}
	return best, bestTime
}

func TestFullReplayCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 300; trial++ {
		n := 1 + rng.Intn(40)
		evs := make([]Event, 0, n)
		for i := 0; i < n; i++ {
			seq := uint64(i + 1)
			tm := int64(rng.Intn(60))
			switch rng.Intn(3) {
			case 0:
				evs = append(evs, borrow(seq, tm, int64(rng.Intn(200))))
			case 1:
				evs = append(evs, repay(seq, tm, int64(rng.Intn(200))))
			default:
				evs = append(evs, reverse(seq, tm, uint64(1+rng.Intn(n))))
			}
		}
		l := NewLedger()
		// Shuffle insertion order; replay must still order by (Time, Seq).
		perm := rng.Perm(len(evs))
		for _, idx := range perm {
			l.Add(evs[idx])
		}
		for q := 0; q < 5; q++ {
			from := int64(rng.Intn(60))
			to := from + 1 + int64(rng.Intn(30))
			wantAmt, wantAt := bruteMaxLiability(evs, from, to)
			gotAmt, gotAt := l.MaxLiability(from, to)
			if gotAmt != wantAmt || gotAt != wantAt {
				t.Fatalf("trial %d query [%d,%d): got (%d,%d), want (%d,%d)\nevents: %+v",
					trial, from, to, gotAmt, gotAt, wantAmt, wantAt, evs)
			}
		}
		// BalanceAt agrees with a brute-force replay of events with Time <= t.
		tm := int64(rng.Intn(60))
		sorted := append([]Event(nil), evs...)
		sort.SliceStable(sorted, func(i, j int) bool {
			if sorted[i].Time != sorted[j].Time {
				return sorted[i].Time < sorted[j].Time
			}
			return sorted[i].Seq < sorted[j].Seq
		})
		last := -1
		for i, ev := range sorted {
			if ev.Time <= tm {
				last = i
			}
		}
		want := int64(0)
		if last >= 0 {
			want = bruteBalanceAt(sorted, last)
		}
		if got := l.BalanceAt(tm); got != want {
			t.Fatalf("trial %d BalanceAt(%d): got %d, want %d", trial, tm, got, want)
		}
	}
}
