package inventory

import (
	"errors"
	"testing"
	"time"
)

var t0 = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func day(n int) time.Time { return t0.AddDate(0, 0, n) }

func TestOutboundFEFOOrder(t *testing.T) {
	l := NewLedger(t0)
	must(t, l.Receive("B-late", 5, day(10)))
	must(t, l.Receive("B-early", 3, day(5)))
	must(t, l.Receive("B-mid", 4, day(7)))

	// First order drains the earliest-expiry batch, then the mid one.
	must(t, l.Outbound(4))
	if got := l.OnHandOf("B-early"); got != 0 {
		t.Fatalf("B-early on-hand = %d, want 0", got)
	}
	if got := l.OnHandOf("B-mid"); got != 3 {
		t.Fatalf("B-mid on-hand = %d, want 3", got)
	}
	if got := l.OnHandOf("B-late"); got != 5 {
		t.Fatalf("B-late on-hand = %d, want 5", got)
	}
}

func TestOutboundTieBreakByBatchID(t *testing.T) {
	l := NewLedger(t0)
	must(t, l.Receive("B2", 2, day(5)))
	must(t, l.Receive("B1", 2, day(5)))

	must(t, l.Outbound(3))
	if got := l.OnHandOf("B1"); got != 0 {
		t.Fatalf("B1 on-hand = %d, want 0 (same expiry, lower ID first)", got)
	}
	if got := l.OnHandOf("B2"); got != 1 {
		t.Fatalf("B2 on-hand = %d, want 1", got)
	}
}

func TestExpiredRetiredBeforeOutbound(t *testing.T) {
	l := NewLedger(t0)
	must(t, l.Receive("old", 4, day(2)))
	must(t, l.Receive("fresh", 4, day(9)))

	// Advance exactly to the expiry moment of "old": it must be
	// retired to scrap first and never consumed by the outbound.
	must(t, l.AdvanceTo(day(2)))
	must(t, l.Outbound(3))

	if got := l.OnHandOf("old"); got != 0 {
		t.Fatalf("old on-hand = %d, want 0", got)
	}
	if got := l.OnHandOf("fresh"); got != 1 {
		t.Fatalf("fresh on-hand = %d, want 1", got)
	}
	tot := l.Totals()
	if tot.Scrapped != 4 {
		t.Fatalf("scrapped = %d, want 4", tot.Scrapped)
	}
	if tot.Consumed != 3 {
		t.Fatalf("consumed = %d, want 3", tot.Consumed)
	}
}

func TestFrozenBatchNotConsumed(t *testing.T) {
	l := NewLedger(t0)
	must(t, l.Receive("frozen", 10, day(3)))
	must(t, l.Receive("open", 2, day(8)))
	must(t, l.Freeze("frozen"))

	// Frozen stock is skipped even though it expires earlier.
	must(t, l.Outbound(2))
	if got := l.OnHandOf("frozen"); got != 10 {
		t.Fatalf("frozen on-hand = %d, want 10", got)
	}
	if got := l.OnHandOf("open"); got != 0 {
		t.Fatalf("open on-hand = %d, want 0", got)
	}

	// With only frozen stock left, the order fails atomically.
	if err := l.Outbound(1); !errors.Is(err, ErrInsufficientStock) {
		t.Fatalf("err = %v, want ErrInsufficientStock", err)
	}

	// After unfreezing, the batch participates again.
	must(t, l.Unfreeze("frozen"))
	must(t, l.Outbound(4))
	if got := l.OnHandOf("frozen"); got != 6 {
		t.Fatalf("frozen on-hand = %d, want 6", got)
	}
}

func TestAtomicOutboundAllOrNothing(t *testing.T) {
	l := NewLedger(t0)
	must(t, l.Receive("a", 3, day(4)))
	must(t, l.Receive("b", 3, day(6)))

	// Order needs 7 in total but only 6 exist: nothing is consumed.
	err := l.Outbound(2, 3, 2)
	if !errors.Is(err, ErrInsufficientStock) {
		t.Fatalf("err = %v, want ErrInsufficientStock", err)
	}
	if got := l.OnHandOf("a"); got != 3 {
		t.Fatalf("a on-hand = %d, want 3 (no partial consumption)", got)
	}
	if got := l.OnHandOf("b"); got != 3 {
		t.Fatalf("b on-hand = %d, want 3 (no partial consumption)", got)
	}
	if tot := l.Totals(); tot.Consumed != 0 {
		t.Fatalf("consumed = %d, want 0", tot.Consumed)
	}

	// A satisfiable multi-line order allocates lines in FEFO order.
	must(t, l.Outbound(2, 3))
	if got := l.OnHandOf("a"); got != 0 {
		t.Fatalf("a on-hand = %d, want 0", got)
	}
	if got := l.OnHandOf("b"); got != 1 {
		t.Fatalf("b on-hand = %d, want 1", got)
	}
}

func TestRefundReturnsToOriginalBatch(t *testing.T) {
	l := NewLedger(t0)
	must(t, l.Receive("x", 5, day(5)))
	must(t, l.Receive("y", 5, day(9)))
	must(t, l.Outbound(4)) // all from x

	must(t, l.Refund("x", 2))
	if got := l.OnHandOf("x"); got != 3 {
		t.Fatalf("x on-hand = %d, want 3", got)
	}
	if got := l.OnHandOf("y"); got != 5 {
		t.Fatalf("y on-hand = %d, want 5 (refund must not leak across batches)", got)
	}
}

func TestRefundExpiredBatchGoesToScrap(t *testing.T) {
	l := NewLedger(t0)
	must(t, l.Receive("z", 5, day(3)))
	must(t, l.Outbound(2))

	must(t, l.AdvanceTo(day(4))) // z is now expired and retired
	must(t, l.Refund("z", 2))

	if got := l.OnHandOf("z"); got != 0 {
		t.Fatalf("z on-hand = %d, want 0", got)
	}
	tot := l.Totals()
	if tot.Scrapped != 5 { // 3 retired on expiry + 2 refunded into scrap
		t.Fatalf("scrapped = %d, want 5", tot.Scrapped)
	}
	if tot.Refunded != 2 {
		t.Fatalf("refunded = %d, want 2", tot.Refunded)
	}
}

func TestAccountIdentity(t *testing.T) {
	l := NewLedger(t0)
	must(t, l.Receive("p", 10, day(2)))
	must(t, l.Receive("q", 8, day(6)))
	must(t, l.Freeze("q"))
	must(t, l.Outbound(4))
	must(t, l.Refund("p", 1))
	must(t, l.AdvanceTo(day(3))) // p expires
	must(t, l.Unfreeze("q"))
	must(t, l.Outbound(3))
	must(t, l.Refund("p", 2)) // expired -> scrap

	tot := l.Totals()
	if tot.Received+tot.Refunded != tot.OnHand+tot.Consumed+tot.Scrapped {
		t.Fatalf("account identity broken: %+v", tot)
	}
	// Explicit expectations: received 18, refunded 3, consumed 7,
	// scrapped 9 (7 expired p incl. the earlier refund + 2 refunded p),
	// on-hand 5 (remaining q).
	want := Totals{Received: 18, Refunded: 3, Consumed: 7, Scrapped: 9, OnHand: 5}
	if tot != want {
		t.Fatalf("totals = %+v, want %+v", tot, want)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
