package ledger

import (
	"math/rand"
	"testing"
)

func mustQuery(t *testing.T, a *Analyzer, start, end, wantMax, wantAt int64) {
	t.Helper()
	gotMax, gotAt := a.MaxLiability(start, end)
	if gotMax != wantMax || gotAt != wantAt {
		t.Fatalf("MaxLiability(%d, %d) = (%d, %d), want (%d, %d)",
			start, end, gotMax, gotAt, wantMax, wantAt)
	}
}

func TestBasicBorrowRepay(t *testing.T) {
	a := NewAnalyzer()
	a.AddEvent(Event{ID: 1, Time: 10, Seq: 1, Type: Borrow, Amount: 100})
	a.AddEvent(Event{ID: 2, Time: 20, Seq: 1, Type: Borrow, Amount: 50})
	a.AddEvent(Event{ID: 3, Time: 30, Seq: 1, Type: Repay, Amount: 70})
	a.AddEvent(Event{ID: 4, Time: 40, Seq: 1, Type: Repay, Amount: 80})

	mustQuery(t, a, 0, 100, 150, 20) // peak after second borrow
	mustQuery(t, a, 30, 100, 80, 30) // declining after t=30
	mustQuery(t, a, 35, 100, 80, 35) // carry-in value 80 is max at interval start
	mustQuery(t, a, 41, 100, 0, 41)  // fully repaid
	mustQuery(t, a, 15, 15, 100, 15) // point query
}

func TestOverRepaymentInvalid(t *testing.T) {
	a := NewAnalyzer()
	a.AddEvent(Event{ID: 1, Time: 1, Seq: 1, Type: Borrow, Amount: 100})
	a.AddEvent(Event{ID: 2, Time: 2, Seq: 1, Type: Repay, Amount: 150}) // illegal: no effect
	a.AddEvent(Event{ID: 3, Time: 3, Seq: 1, Type: Repay, Amount: 0})   // illegal: no effect
	a.AddEvent(Event{ID: 4, Time: 4, Seq: 1, Type: Repay, Amount: -5})  // illegal: no effect
	a.AddEvent(Event{ID: 5, Time: 5, Seq: 1, Type: Repay, Amount: 60})  // partial, effective

	mustQuery(t, a, 0, 10, 100, 1)
	mustQuery(t, a, 5, 10, 40, 5)
	mustQuery(t, a, 2, 4, 100, 2) // illegal events left liability at 100
}

func TestReversal(t *testing.T) {
	a := NewAnalyzer()
	a.AddEvent(Event{ID: 1, Time: 1, Seq: 1, Type: Borrow, Amount: 100})
	a.AddEvent(Event{ID: 2, Time: 2, Seq: 1, Type: Repay, Amount: 40})
	a.AddEvent(Event{ID: 3, Time: 3, Seq: 1, Type: Reverse, RefID: 2})  // undo repay: 100
	a.AddEvent(Event{ID: 4, Time: 4, Seq: 1, Type: Reverse, RefID: 2})  // already reversed: no effect
	a.AddEvent(Event{ID: 5, Time: 5, Seq: 1, Type: Reverse, RefID: 99}) // unknown: no effect
	a.AddEvent(Event{ID: 6, Time: 6, Seq: 1, Type: Reverse, RefID: 1})  // undo borrow: 0

	mustQuery(t, a, 0, 2, 100, 1)
	mustQuery(t, a, 2, 2, 60, 2)
	mustQuery(t, a, 3, 5, 100, 3)
	mustQuery(t, a, 6, 10, 0, 6)
	mustQuery(t, a, 0, 10, 100, 1)
}

func TestReversalOfInvalidRepay(t *testing.T) {
	a := NewAnalyzer()
	a.AddEvent(Event{ID: 1, Time: 1, Seq: 1, Type: Borrow, Amount: 50})
	a.AddEvent(Event{ID: 2, Time: 2, Seq: 1, Type: Repay, Amount: 80}) // illegal, never effective
	a.AddEvent(Event{ID: 3, Time: 3, Seq: 1, Type: Reverse, RefID: 2}) // target never effective: no effect

	mustQuery(t, a, 0, 10, 50, 1)
	mustQuery(t, a, 3, 10, 50, 3)
}

func TestCarryAcrossBoundary(t *testing.T) {
	a := NewAnalyzer()
	a.AddEvent(Event{ID: 1, Time: 1, Seq: 1, Type: Borrow, Amount: 200})
	a.AddEvent(Event{ID: 2, Time: 2, Seq: 1, Type: Repay, Amount: 50})

	// No events inside the interval: outstanding liability carries in.
	mustQuery(t, a, 10, 20, 150, 10)
	mustQuery(t, a, 2, 20, 150, 2)
}

func TestSameTimeSeqOrder(t *testing.T) {
	a := NewAnalyzer()
	// Same timestamp: seq decides order. Repay (seq 1) runs before the
	// borrow (seq 2), so it is illegal and has no effect.
	a.AddEvent(Event{ID: 1, Time: 5, Seq: 2, Type: Borrow, Amount: 70})
	a.AddEvent(Event{ID: 2, Time: 5, Seq: 1, Type: Repay, Amount: 30})
	a.AddEvent(Event{ID: 3, Time: 6, Seq: 1, Type: Repay, Amount: 30})

	mustQuery(t, a, 0, 10, 70, 5)
	mustQuery(t, a, 6, 10, 40, 6)
}

func TestIncrementalAdds(t *testing.T) {
	a := NewAnalyzer()
	a.AddEvent(Event{ID: 1, Time: 10, Seq: 1, Type: Borrow, Amount: 100})
	mustQuery(t, a, 0, 100, 100, 10)

	// Out-of-order add after a query: index must rebuild.
	a.AddEvent(Event{ID: 2, Time: 5, Seq: 1, Type: Borrow, Amount: 40})
	mustQuery(t, a, 0, 100, 140, 10)
	mustQuery(t, a, 0, 9, 40, 5)

	a.AddEvent(Event{ID: 3, Time: 7, Seq: 1, Type: Reverse, RefID: 2})
	mustQuery(t, a, 0, 100, 100, 10)
}

func TestDegenerate(t *testing.T) {
	a := NewAnalyzer()
	mustQuery(t, a, 0, 100, 0, 0)  // no events
	mustQuery(t, a, 50, 10, 0, 50) // start > end
	mustQuery(t, a, -100, -1, 0, -100)
}

// TestFullReplayCrossCheck feeds randomized event streams and intervals to
// both the indexed Analyzer and the naive complete replay, requiring
// identical results.
func TestFullReplayCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 300; trial++ {
		n := rng.Intn(60)
		events := make([]Event, 0, n)
		for i := 0; i < n; i++ {
			e := Event{
				ID:   int64(rng.Intn(20) + 1),
				Time: int64(rng.Intn(50)),
				Seq:  int64(rng.Intn(5)),
			}
			switch rng.Intn(4) {
			case 0, 1:
				e.Type = Borrow
				e.Amount = int64(rng.Intn(60)) - 5 // sometimes non-positive
			case 2:
				e.Type = Repay
				e.Amount = int64(rng.Intn(120)) - 5 // often over-repays
			default:
				e.Type = Reverse
				e.RefID = int64(rng.Intn(22)) // sometimes unknown
			}
			events = append(events, e)
		}

		a := NewAnalyzer()
		for _, e := range events {
			a.AddEvent(e)
		}
		for q := 0; q < 25; q++ {
			start := int64(rng.Intn(55)) - 5
			end := start + int64(rng.Intn(20)) - 3 // sometimes start > end
			wantMax, wantAt := ReplayMaxLiability(events, start, end)
			gotMax, gotAt := a.MaxLiability(start, end)
			if gotMax != wantMax || gotAt != wantAt {
				t.Fatalf("trial %d query [%d,%d]: analyzer=(%d,%d) replay=(%d,%d)",
					trial, start, end, gotMax, gotAt, wantMax, wantAt)
			}
		}
	}
}

// TestFullReplayCrossCheckIncremental interleaves additions and queries.
func TestFullReplayCrossCheckIncremental(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	a := NewAnalyzer()
	var events []Event
	for i := 0; i < 120; i++ {
		e := Event{
			ID:   int64(i + 1),
			Time: int64(rng.Intn(80)),
			Seq:  int64(rng.Intn(3)),
		}
		switch rng.Intn(3) {
		case 0:
			e.Type = Borrow
			e.Amount = int64(rng.Intn(50) + 1)
		case 1:
			e.Type = Repay
			e.Amount = int64(rng.Intn(80) + 1)
		default:
			e.Type = Reverse
			e.RefID = int64(rng.Intn(i + 1))
		}
		events = append(events, e)
		a.AddEvent(e)

		start := int64(rng.Intn(85)) - 5
		end := start + int64(rng.Intn(30))
		wantMax, wantAt := ReplayMaxLiability(events, start, end)
		gotMax, gotAt := a.MaxLiability(start, end)
		if gotMax != wantMax || gotAt != wantAt {
			t.Fatalf("after %d events, query [%d,%d]: analyzer=(%d,%d) replay=(%d,%d)",
				len(events), start, end, gotMax, gotAt, wantMax, wantAt)
		}
	}
}
