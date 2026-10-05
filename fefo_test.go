package fefo

import (
	"reflect"
	"testing"
)

// scenario builds the base event log used by most tests:
//
//	day 01: receive A(100, exp 03), B(100, exp 10); order O1(60)
//	day 02: order O2(80); return R1: O1 -20
//	day 04: receive C(50, exp 05); order O3(30)   (A expires end of day 03)
//	day 06: return R2: O2 -50                    (C expires end of day 05)
func scenario() []Event {
	return []Event{
		&Receipt{ID: "rc-A", Date: "2026-01-01", Batch: "A", Qty: 100, Expiry: "2026-01-03"},
		&Receipt{ID: "rc-B", Date: "2026-01-01", Batch: "B", Qty: 100, Expiry: "2026-01-10"},
		&Order{ID: "O1", Date: "2026-01-01", Qty: 60},
		&Order{ID: "O2", Date: "2026-01-02", Qty: 80},
		&Return{ID: "rt-1", Date: "2026-01-02", OrderID: "O1", Qty: 20},
		&Receipt{ID: "rc-C", Date: "2026-01-04", Batch: "C", Qty: 50, Expiry: "2026-01-05"},
		&Order{ID: "O3", Date: "2026-01-04", Qty: 30},
		&Return{ID: "rt-2", Date: "2026-01-06", OrderID: "O2", Qty: 50},
	}
}

func mustReplay(t *testing.T, log []Event) *State {
	t.Helper()
	s, err := Replay(log)
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if err := s.CheckConservation(); err != nil {
		t.Fatalf("conservation: %v", err)
	}
	return s
}

func allocs(s *State, order string) []Allocation {
	a, ok := s.Sources(order)
	if !ok {
		return nil
	}
	return a
}

func TestFEFOAllocationAcrossDates(t *testing.T) {
	s := mustReplay(t, scenario())

	// O1 ships entirely from the earliest-expiry batch A; R1 later returns
	// 20 of it while A is still good.
	wantO1 := []Allocation{{Batch: "A", Expiry: "2026-01-03", Qty: 60, Returned: 20}}
	if got := allocs(s, "O1"); !reflect.DeepEqual(got, wantO1) {
		t.Errorf("O1 sources = %+v, want %+v", got, wantO1)
	}

	// O2 first drains the rest of A (40), then falls back to B (40).
	// R2 later returns 50 of O2 in reverse source order: 40 from B, 10 from A.
	wantO2 := []Allocation{
		{Batch: "A", Expiry: "2026-01-03", Qty: 40, Returned: 10},
		{Batch: "B", Expiry: "2026-01-10", Qty: 40, Returned: 40},
	}
	if got := allocs(s, "O2"); !reflect.DeepEqual(got, wantO2) {
		t.Errorf("O2 sources = %+v, want %+v", got, wantO2)
	}

	// By day 04 batch A (expiry 01-03) is expired and scrapped, so O3 is
	// served by C (expiry 01-05) ahead of the longer-lived B.
	wantO3 := []Allocation{{Batch: "C", Expiry: "2026-01-05", Qty: 30}}
	if got := allocs(s, "O3"); !reflect.DeepEqual(got, wantO3) {
		t.Errorf("O3 sources = %+v, want %+v", got, wantO3)
	}
	if got := s.Batches["A"].Scrapped; got != 30 {
		t.Errorf("batch A scrapped = %d, want 30 (20 restocked then expired on shelf + 10 expired return)", got)
	}
}

func TestReturnRestoresUnexpiredAndScrapsExpired(t *testing.T) {
	s := mustReplay(t, scenario())

	// R1 on day 02 puts 20 back into batch A while it is still good, but
	// A expires end of day 03, so by the end of the replay those 20 have
	// been written off the shelf and nothing of A remains.
	if got := s.Batches["A"].Remaining; got != 0 {
		t.Fatalf("A remaining = %d, want 0 (restocked 20 expired on shelf)", got)
	}

	// R2 on day 06 returns 50 of O2 (A:40 + B:40), restored in reverse
	// allocation order: B takes 40 (unexpired, back in stock), A takes 10
	// but expired on 01-03, so those 10 are scrapped.
	if got := s.Batches["B"].Remaining; got != 100 {
		t.Errorf("B remaining = %d, want 100 (60 left + 40 restocked)", got)
	}
	if got := s.Batches["A"].Scrapped; got != 30 {
		t.Errorf("A scrapped = %d, want 30 (20 expired on shelf + 10 expired return)", got)
	}

	// Batch C (expiry 01-05) had 20 left after O3; it expires before day 06.
	if got := s.Batches["C"].Scrapped; got != 20 {
		t.Errorf("C scrapped = %d, want 20", got)
	}
	if got := s.Scrapped; got != 50 {
		t.Errorf("total scrapped = %d, want 50", got)
	}
	if got := s.Orders["O2"].Returned; got != 50 {
		t.Errorf("O2 returned = %d, want 50", got)
	}
}

func TestDailyLedgerConservation(t *testing.T) {
	s := mustReplay(t, scenario())

	want := []DayLedger{
		{Date: "2026-01-01", Received: 200, Shipped: 60, OnHand: 140},
		{Date: "2026-01-02", Shipped: 80, Returned: 20, Restocked: 20, OnHand: 80},
		{Date: "2026-01-04", Received: 50, Shipped: 30, Scrapped: 20, OnHand: 80},
		{Date: "2026-01-06", Returned: 50, Restocked: 40, Scrapped: 20, ReturnScrapped: 10, OnHand: 100},
	}
	if !reflect.DeepEqual(s.Ledger, want) {
		t.Errorf("ledger mismatch\n got: %+v\nwant: %+v", s.Ledger, want)
	}

	// Independent daily model: on-hand is a pure running sum of flows and
	// must land on the batch-level stock at every day boundary.
	onHand := 0
	for _, d := range s.Ledger {
		onHand += d.Received - d.Shipped + d.Restocked - d.Scrapped
		if onHand != d.OnHand {
			t.Errorf("day %s: flow model onHand %d != batch model %d", d.Date, onHand, d.OnHand)
		}
	}

	// Global identity recomputed independently from the raw event log.
	received, ordered, returned := 0, 0, 0
	for _, ev := range scenario() {
		switch e := ev.(type) {
		case *Receipt:
			received += e.Qty
		case *Order:
			ordered += e.Qty
		case *Return:
			returned += e.Qty
		}
	}
	if got := onHand + (ordered - returned) + s.Scrapped; got != received {
		t.Errorf("identity: received %d != onHand+netShipped+scrapped %d", received, got)
	}
}

func TestAmendRequiresReplay(t *testing.T) {
	log := scenario()
	// Correction: receipt rc-A was mis-keyed, the real quantity was 120.
	log = append(log, &Amend{
		ID:       "fix-1",
		Date:     "2026-01-03",
		TargetID: "rc-A",
		Replacement: &Receipt{
			ID: "rc-A", Date: "2026-01-01", Batch: "A", Qty: 120, Expiry: "2026-01-03",
		},
	})
	s := mustReplay(t, log)

	// With 20 extra in A, O2 now draws A:60 + B:20 instead of A:40 + B:40.
	wantO2 := []Allocation{
		{Batch: "A", Expiry: "2026-01-03", Qty: 60, Returned: 30},
		{Batch: "B", Expiry: "2026-01-10", Qty: 20, Returned: 20},
	}
	if got := allocs(s, "O2"); !reflect.DeepEqual(got, wantO2) {
		t.Errorf("after amend, O2 sources = %+v, want %+v", got, wantO2)
	}
	// R2 (return 50 of O2, reverse order): B takes 20 back, A takes 30 but
	// is expired by day 06 and is scrapped.
	if got := s.Batches["B"].Remaining; got != 100 {
		t.Errorf("after amend, B remaining = %d, want 100", got)
	}
	if got := s.Batches["A"].Scrapped; got != 50 {
		t.Errorf("after amend, A scrapped = %d, want 50 (20 shelf + 30 expired return)", got)
	}
	if got := s.Batches["A"].Received; got != 120 {
		t.Errorf("after amend, A received = %d, want 120", got)
	}
}

func TestAmendVoidDeletesEvent(t *testing.T) {
	log := scenario()
	log = append(log, &Amend{ID: "fix-void", Date: "2026-01-03", TargetID: "O2"})

	// Voiding O2 alone breaks replay: rt-2 now references a missing order.
	if _, err := Replay(log); err == nil {
		t.Fatal("expected replay error for dangling return rt-2")
	}

	// Voiding the dependent return as well makes the log consistent again.
	log = append(log, &Amend{ID: "fix-void-2", Date: "2026-01-03", TargetID: "rt-2"})
	s := mustReplay(t, log)
	if _, ok := s.Orders["O2"]; ok {
		t.Error("voided order O2 still present after replay")
	}
	if got := s.Batches["A"].Remaining; got != 0 {
		t.Errorf("A remaining = %d, want 0 (60 shipped, 20 returned then expired on shelf)", got)
	}
}

func TestShortageRecorded(t *testing.T) {
	s := mustReplay(t, []Event{
		&Receipt{ID: "rc-1", Date: "2026-02-01", Batch: "X", Qty: 10, Expiry: "2026-02-28"},
		&Order{ID: "big", Date: "2026-02-02", Qty: 25},
	})
	o := s.Orders["big"]
	if o.Shipped != 10 || o.Shortage != 15 {
		t.Errorf("shipped %d shortage %d, want 10/15", o.Shipped, o.Shortage)
	}
}

func TestReturnBoundaries(t *testing.T) {
	// Return on the exact expiry date is still restockable (expiry is
	// inclusive); one day later it must be scrapped.
	s := mustReplay(t, []Event{
		&Receipt{ID: "rc-1", Date: "2026-03-01", Batch: "X", Qty: 10, Expiry: "2026-03-05"},
		&Order{ID: "O", Date: "2026-03-01", Qty: 10},
		&Return{ID: "r1", Date: "2026-03-05", OrderID: "O", Qty: 4},
		&Return{ID: "r2", Date: "2026-03-06", OrderID: "O", Qty: 6},
	})
	// The 4 units returned on the expiry date went back on the shelf, then
	// expired there overnight; the 6 units returned a day late were
	// scrapped directly. Nothing remains.
	if got := s.Batches["X"].Remaining; got != 0 {
		t.Errorf("remaining = %d, want 0", got)
	}
	if got := s.Batches["X"].Scrapped; got != 10 {
		t.Errorf("scrapped = %d, want 10 (4 shelf expiry + 6 expired return)", got)
	}
	// The ledger separates the two scrap causes.
	var d5, d6 DayLedger
	for _, d := range s.Ledger {
		switch d.Date {
		case "2026-03-05":
			d5 = d
		case "2026-03-06":
			d6 = d
		}
	}
	if d5.Restocked != 4 || d5.OnHand != 4 {
		t.Errorf("day 03-05 = %+v, want restocked 4 on-hand 4", d5)
	}
	if d6.Scrapped != 4 || d6.ReturnScrapped != 6 || d6.OnHand != 0 {
		t.Errorf("day 03-06 = %+v, want scrapped 4 return-scrapped 6 on-hand 0", d6)
	}
}

func TestReplayRejectsBadLogs(t *testing.T) {
	cases := map[string][]Event{
		"duplicate ID": {
			&Receipt{ID: "e1", Date: "2026-01-01", Batch: "A", Qty: 1, Expiry: "2026-01-02"},
			&Receipt{ID: "e1", Date: "2026-01-01", Batch: "B", Qty: 1, Expiry: "2026-01-02"},
		},
		"amend unknown target": {
			&Amend{ID: "a1", Date: "2026-01-01", TargetID: "nope"},
		},
		"amend ID mismatch": {
			&Receipt{ID: "e1", Date: "2026-01-01", Batch: "A", Qty: 1, Expiry: "2026-01-02"},
			&Amend{ID: "a1", Date: "2026-01-01", TargetID: "e1",
				Replacement: &Receipt{ID: "other", Date: "2026-01-01", Batch: "A", Qty: 1, Expiry: "2026-01-02"}},
		},
		"return exceeds shipped": {
			&Receipt{ID: "e1", Date: "2026-01-01", Batch: "A", Qty: 5, Expiry: "2026-01-09"},
			&Order{ID: "O", Date: "2026-01-01", Qty: 5},
			&Return{ID: "r1", Date: "2026-01-02", OrderID: "O", Qty: 6},
		},
		"return unknown order": {
			&Return{ID: "r1", Date: "2026-01-02", OrderID: "ghost", Qty: 1},
		},
		"expired receipt": {
			&Receipt{ID: "e1", Date: "2026-01-05", Batch: "A", Qty: 1, Expiry: "2026-01-02"},
		},
	}
	for name, log := range cases {
		if _, err := Replay(log); err == nil {
			t.Errorf("%s: expected error, got nil", name)
		}
	}
}
