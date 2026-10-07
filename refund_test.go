package refund

import (
	"errors"
	"fmt"
	"reflect"
	"testing"
)

func mustLedger(t *testing.T, accounts ...Account) *Ledger {
	t.Helper()
	l, err := NewLedger(accounts)
	if err != nil {
		t.Fatalf("NewLedger: %v", err)
	}
	return l
}

func TestAllocateFloorAndRemainderByAccountID(t *testing.T) {
	// total = 600; refund 100 -> floor shares 16/33/50 = 99, remainder 1
	// goes to the smallest account ID.
	l := mustLedger(t,
		Account{ID: "c", Paid: 300},
		Account{ID: "a", Paid: 100},
		Account{ID: "b", Paid: 200},
	)
	got := l.Allocate(100)
	want := map[string]int64{"a": 17, "b": 33, "c": 50}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Allocate(100) = %v, want %v", got, want)
	}
}

func TestRefundTopsUpDeltaOnly(t *testing.T) {
	l := mustLedger(t,
		Account{ID: "a", Paid: 100},
		Account{ID: "b", Paid: 200},
		Account{ID: "c", Paid: 300},
	)
	d1, err := l.Refund("r1", 100)
	if err != nil {
		t.Fatalf("Refund r1: %v", err)
	}
	if want := map[string]int64{"a": 17, "b": 33, "c": 50}; !reflect.DeepEqual(d1, want) {
		t.Fatalf("first delta = %v, want %v", d1, want)
	}
	// Cumulative 200 -> shares 34/66/100; second request pays only the diff.
	d2, err := l.Refund("r2", 100)
	if err != nil {
		t.Fatalf("Refund r2: %v", err)
	}
	if want := map[string]int64{"a": 17, "b": 33, "c": 50}; !reflect.DeepEqual(d2, want) {
		t.Fatalf("second delta = %v, want %v", d2, want)
	}
	if got := l.TotalRefunded(); got != 200 {
		t.Fatalf("TotalRefunded = %d, want 200", got)
	}
}

func TestDuplicateRequestID(t *testing.T) {
	l := mustLedger(t, Account{ID: "a", Paid: 50}, Account{ID: "b", Paid: 50})
	if _, err := l.Refund("r1", 30); err != nil {
		t.Fatalf("Refund r1: %v", err)
	}
	// Same ID, same amount: idempotent no-op.
	d, err := l.Refund("r1", 30)
	if err != nil {
		t.Fatalf("idempotent replay: %v", err)
	}
	if len(d) != 0 {
		t.Fatalf("idempotent replay delta = %v, want empty", d)
	}
	if got := l.TotalRefunded(); got != 30 {
		t.Fatalf("TotalRefunded = %d, want 30 (no double count)", got)
	}
	// Same ID, different amount: rejected, state untouched.
	if _, err := l.Refund("r1", 31); !errors.Is(err, ErrDuplicateRequest) {
		t.Fatalf("conflicting replay err = %v, want ErrDuplicateRequest", err)
	}
	if got := l.TotalRefunded(); got != 30 {
		t.Fatalf("TotalRefunded = %d after rejection, want 30", got)
	}
}

func TestRefundNeverExceedsOriginal(t *testing.T) {
	l := mustLedger(t, Account{ID: "a", Paid: 60}, Account{ID: "b", Paid: 40})
	if _, err := l.Refund("r1", 101); !errors.Is(err, ErrExceedsTotal) {
		t.Fatalf("over-refund err = %v, want ErrExceedsTotal", err)
	}
	if _, err := l.Refund("r2", 100); err != nil {
		t.Fatalf("full refund: %v", err)
	}
	if _, err := l.Refund("r3", 1); !errors.Is(err, ErrExceedsTotal) {
		t.Fatalf("post-full refund err = %v, want ErrExceedsTotal", err)
	}
	if got := l.TotalRefunded(); got != 100 {
		t.Fatalf("TotalRefunded = %d, want 100", got)
	}
}

func TestFullRefundRestoresOriginalSplit(t *testing.T) {
	l := mustLedger(t,
		Account{ID: "a", Paid: 7},
		Account{ID: "b", Paid: 13},
		Account{ID: "c", Paid: 29},
	)
	if _, err := l.Refund("r1", 49); err != nil {
		t.Fatalf("Refund: %v", err)
	}
	for id, want := range map[string]int64{"a": 7, "b": 13, "c": 29} {
		if got := l.Refunded(id); got != want {
			t.Fatalf("Refunded(%q) = %d, want %d", id, got, want)
		}
	}
}

func TestNegativeAmountAndInvalidLedger(t *testing.T) {
	l := mustLedger(t, Account{ID: "a", Paid: 1})
	if _, err := l.Refund("r1", -1); !errors.Is(err, ErrInvalidAmount) {
		t.Fatalf("negative amount err = %v, want ErrInvalidAmount", err)
	}
	if _, err := NewLedger(nil); err == nil {
		t.Fatal("empty accounts: want error")
	}
	if _, err := NewLedger([]Account{{ID: "a", Paid: 1}, {ID: "a", Paid: 2}}); err == nil {
		t.Fatal("duplicate account id: want error")
	}
	if _, err := NewLedger([]Account{{ID: "a", Paid: 0}}); err == nil {
		t.Fatal("non-positive paid: want error")
	}
}

// compositions enumerates all ways to write n as an ordered sum of k positive
// integers, invoking fn for each split.
func compositions(n, k int, fn func([]int64)) {
	var rec func(remaining, slots int, prefix []int64)
	rec = func(remaining, slots int, prefix []int64) {
		if slots == 1 {
			fn(append(append([]int64{}, prefix...), int64(remaining)))
			return
		}
		for first := 1; first <= remaining-(slots-1); first++ {
			rec(remaining-first, slots-1, append(prefix, int64(first)))
		}
	}
	rec(n, k, nil)
}

// TestSplitSequencesConvergeToSingleRefund enumerates every way to split a
// total refund into a sequence of partial refunds and verifies that the
// accumulated per-account payouts always equal the one-shot allocation.
func TestSplitSequencesConvergeToSingleRefund(t *testing.T) {
	accountSets := [][]Account{
		{{ID: "a", Paid: 1}, {ID: "b", Paid: 1}, {ID: "c", Paid: 1}},
		{{ID: "a", Paid: 100}, {ID: "b", Paid: 200}, {ID: "c", Paid: 300}},
		{{ID: "x", Paid: 7}, {ID: "y", Paid: 13}, {ID: "z", Paid: 29}},
		{{ID: "p", Paid: 3}, {ID: "q", Paid: 5}},
	}
	for _, accounts := range accountSets {
		var total int64
		for _, a := range accounts {
			total += a.Paid
		}
		for refundTotal := int64(1); refundTotal <= total && refundTotal <= 12; refundTotal++ {
			reference := mustLedger(t, accounts...).Allocate(refundTotal)
			for steps := 1; steps <= 4 && steps <= int(refundTotal); steps++ {
				compositions(int(refundTotal), steps, func(split []int64) {
					l := mustLedger(t, accounts...)
					got := make(map[string]int64, len(accounts))
					for i, amount := range split {
						delta, err := l.Refund(fmt.Sprintf("req-%d", i), amount)
						if err != nil {
							t.Fatalf("accounts=%v split=%v: Refund: %v", accounts, split, err)
						}
						for id, d := range delta {
							got[id] += d
						}
					}
					if l.TotalRefunded() != refundTotal {
						t.Fatalf("accounts=%v split=%v: TotalRefunded = %d, want %d",
							accounts, split, l.TotalRefunded(), refundTotal)
					}
					for id, want := range reference {
						if got[id] != want {
							t.Fatalf("accounts=%v split=%v: account %q got %d, want %d (full=%v)",
								accounts, split, id, got[id], want, reference)
						}
					}
				})
			}
		}
	}
}
