package inventory

import (
	"errors"
	"reflect"
	"testing"
)

func newTestStore() *Store {
	return NewStore(map[string]int64{"A": 10, "B": 5, "C": 8})
}

func levels(t *testing.T, s *Store, batch string) (reserved, consumed, available int64) {
	t.Helper()
	_, r, c, a, ok := s.BatchLevel(batch)
	if !ok {
		t.Fatalf("batch %s missing", batch)
	}
	return r, c, a
}

func TestReserveAcrossMultipleBatches(t *testing.T) {
	s := newTestStore()
	r, err := s.Reserve(1, "req-1", "order-1", []Line{{Batch: "A", Qty: 7}, {Batch: "B", Qty: 3}}, 100)
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if r.State != Active || r.Generation != 1 || r.ID != "order-1#1" {
		t.Fatalf("unexpected reservation: %+v", r)
	}
	if res, _, avail := levels(t, s, "A"); res != 7 || avail != 3 {
		t.Fatalf("batch A: reserved=%d available=%d", res, avail)
	}
	if res, _, avail := levels(t, s, "B"); res != 3 || avail != 2 {
		t.Fatalf("batch B: reserved=%d available=%d", res, avail)
	}
	if err := s.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestReserveInsufficientStock(t *testing.T) {
	s := newTestStore()
	if _, err := s.Reserve(1, "req-1", "order-1", []Line{{Batch: "B", Qty: 6}}, 100); !errors.Is(err, ErrInsufficientStock) {
		t.Fatalf("want ErrInsufficientStock, got %v", err)
	}
	if _, err := s.Reserve(1, "req-2", "order-2", []Line{{Batch: "Z", Qty: 1}}, 100); !errors.Is(err, ErrUnknownBatch) {
		t.Fatalf("want ErrUnknownBatch, got %v", err)
	}
	if err := s.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestConfirmTransfersWholeBatchSet(t *testing.T) {
	s := newTestStore()
	r, _ := s.Reserve(1, "req-1", "order-1", []Line{{Batch: "A", Qty: 4}, {Batch: "C", Qty: 5}}, 100)
	if err := s.Confirm(2, "req-2", r.ID); err != nil {
		t.Fatalf("confirm: %v", err)
	}
	// Every line moved reserved -> consumed in one shot.
	if res, con, avail := levels(t, s, "A"); res != 0 || con != 4 || avail != 6 {
		t.Fatalf("batch A: reserved=%d consumed=%d available=%d", res, con, avail)
	}
	if res, con, avail := levels(t, s, "C"); res != 0 || con != 5 || avail != 3 {
		t.Fatalf("batch C: reserved=%d consumed=%d available=%d", res, con, avail)
	}
	got, _ := s.Reservation(r.ID)
	if got.State != Confirmed {
		t.Fatalf("state = %s", got.State)
	}
	// A second confirm loses: the reservation is no longer active.
	if err := s.Confirm(3, "req-3", r.ID); !errors.Is(err, ErrReservationNotActive) {
		t.Fatalf("want ErrReservationNotActive, got %v", err)
	}
	if err := s.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestExpiryIncludesDeadlineMoment(t *testing.T) {
	s := newTestStore()
	r, _ := s.Reserve(1, "req-1", "order-1", []Line{{Batch: "A", Qty: 2}}, 50)
	// At now == deadline the reservation is already expired: confirm loses.
	if err := s.Confirm(50, "req-2", r.ID); !errors.Is(err, ErrReservationNotActive) {
		t.Fatalf("confirm at deadline: want ErrReservationNotActive, got %v", err)
	}
	got, _ := s.Reservation(r.ID)
	if got.State != Expired {
		t.Fatalf("state = %s, want expired", got.State)
	}
	if res, _, avail := levels(t, s, "A"); res != 0 || avail != 10 {
		t.Fatalf("expiry did not release holds: reserved=%d available=%d", res, avail)
	}

	// One tick before the deadline the same confirm would have won.
	s2 := newTestStore()
	r2, _ := s2.Reserve(1, "req-1", "order-1", []Line{{Batch: "A", Qty: 2}}, 50)
	if err := s2.Confirm(49, "req-2", r2.ID); err != nil {
		t.Fatalf("confirm before deadline: %v", err)
	}
	if err := s.Verify(); err != nil {
		t.Fatal(err)
	}
	if err := s2.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestEventOrderDecidesRaces(t *testing.T) {
	// Cancel before confirm: cancel wins, confirm loses.
	s := newTestStore()
	r, _ := s.Reserve(1, "req-1", "order-1", []Line{{Batch: "A", Qty: 3}}, 100)
	if err := s.Cancel(2, "req-2", r.ID); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if err := s.Confirm(3, "req-3", r.ID); !errors.Is(err, ErrReservationNotActive) {
		t.Fatalf("confirm after cancel: want ErrReservationNotActive, got %v", err)
	}

	// Confirm before cancel: confirm wins, cancel loses.
	s2 := newTestStore()
	r2, _ := s2.Reserve(1, "req-1", "order-1", []Line{{Batch: "A", Qty: 3}}, 100)
	if err := s2.Confirm(2, "req-2", r2.ID); err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if err := s2.Cancel(3, "req-3", r2.ID); !errors.Is(err, ErrReservationNotActive) {
		t.Fatalf("cancel after confirm: want ErrReservationNotActive, got %v", err)
	}

	// Expiry event ordered before a same-tick cancel: expiry wins.
	s3 := newTestStore()
	r3, _ := s3.Reserve(1, "req-1", "order-1", []Line{{Batch: "A", Qty: 3}}, 10)
	if err := s3.Cancel(10, "req-2", r3.ID); !errors.Is(err, ErrReservationNotActive) {
		t.Fatalf("cancel at deadline: want ErrReservationNotActive, got %v", err)
	}
	got, _ := s3.Reservation(r3.ID)
	if got.State != Expired {
		t.Fatalf("state = %s, want expired", got.State)
	}
	for _, st := range []*Store{s, s2, s3} {
		if err := st.Verify(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRequestIDBindsParameters(t *testing.T) {
	s := newTestStore()
	r1, err := s.Reserve(1, "req-1", "order-1", []Line{{Batch: "A", Qty: 2}}, 100)
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	// Same request ID, same parameters: idempotent replay, no new hold.
	r2, err := s.Reserve(1, "req-1", "order-1", []Line{{Batch: "A", Qty: 2}}, 100)
	if err != nil || r2.ID != r1.ID {
		t.Fatalf("idempotent replay: id=%s err=%v", r2.ID, err)
	}
	if res, _, _ := levels(t, s, "A"); res != 2 {
		t.Fatalf("replay double-held stock: reserved=%d", res)
	}
	// Same request ID, different parameters: conflict.
	if _, err := s.Reserve(1, "req-1", "order-1", []Line{{Batch: "A", Qty: 3}}, 100); !errors.Is(err, ErrRequestConflict) {
		t.Fatalf("want ErrRequestConflict, got %v", err)
	}
	if _, err := s.Reserve(1, "req-1", "order-9", []Line{{Batch: "A", Qty: 2}}, 100); !errors.Is(err, ErrRequestConflict) {
		t.Fatalf("different key: want ErrRequestConflict, got %v", err)
	}
	// Confirm replays idempotently too.
	if err := s.Confirm(2, "req-2", r1.ID); err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if err := s.Confirm(3, "req-2", r1.ID); err != nil {
		t.Fatalf("confirm replay: %v", err)
	}
	if _, con, _ := levels(t, s, "A"); con != 2 {
		t.Fatalf("confirm replay double-consumed: consumed=%d", con)
	}
	if err := s.Confirm(4, "req-2", "order-1#99"); !errors.Is(err, ErrRequestConflict) {
		t.Fatalf("confirm different params: want ErrRequestConflict, got %v", err)
	}
	if err := s.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestReacquireGetsNewGeneration(t *testing.T) {
	s := newTestStore()
	r1, _ := s.Reserve(1, "req-1", "order-1", []Line{{Batch: "A", Qty: 2}}, 10)
	// Let it expire, then re-acquire: new generation, new reservation ID.
	r2, err := s.Reserve(20, "req-2", "order-1", []Line{{Batch: "A", Qty: 4}}, 100)
	if err != nil {
		t.Fatalf("re-acquire after expiry: %v", err)
	}
	if r2.Generation != 2 || r2.ID == r1.ID {
		t.Fatalf("want generation 2 with new ID, got %+v (first %s)", r2, r1.ID)
	}
	// Cancel the active one, re-acquire again: generation 3.
	if err := s.Cancel(21, "req-3", r2.ID); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	r3, err := s.Reserve(22, "req-4", "order-1", []Line{{Batch: "A", Qty: 1}}, 100)
	if err != nil {
		t.Fatalf("re-acquire after cancel: %v", err)
	}
	if r3.Generation != 3 {
		t.Fatalf("want generation 3, got %d", r3.Generation)
	}
	// While one is active, the key cannot be reserved again.
	if _, err := s.Reserve(23, "req-5", "order-1", []Line{{Batch: "A", Qty: 1}}, 100); !errors.Is(err, ErrKeyAlreadyReserved) {
		t.Fatalf("want ErrKeyAlreadyReserved, got %v", err)
	}
	if err := s.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestReplayMatchesAndConservesPerBatch(t *testing.T) {
	initial := map[string]int64{"A": 10, "B": 5, "C": 8}
	s := NewStore(initial)

	r1, _ := s.Reserve(1, "q1", "order-1", []Line{{Batch: "A", Qty: 4}, {Batch: "B", Qty: 2}}, 30)
	r2, _ := s.Reserve(2, "q2", "order-2", []Line{{Batch: "C", Qty: 6}}, 10)
	r3, _ := s.Reserve(3, "q3", "order-3", []Line{{Batch: "A", Qty: 1}, {Batch: "C", Qty: 1}}, 100)
	if err := s.Confirm(4, "q4", r1.ID); err != nil { // confirm before its deadline
		t.Fatalf("confirm r1: %v", err)
	}
	if err := s.Cancel(5, "q5", r3.ID); err != nil {
		t.Fatalf("cancel r3: %v", err)
	}
	// r2 expires at its deadline (inclusive); re-acquire with new generation.
	r4, err := s.Reserve(10, "q6", "order-2", []Line{{Batch: "C", Qty: 3}}, 200)
	if err != nil {
		t.Fatalf("re-acquire order-2: %v", err)
	}
	if r4.Generation != 2 {
		t.Fatalf("order-2 generation = %d, want 2", r4.Generation)
	}
	if err := s.Confirm(11, "q7", r4.ID); err != nil {
		t.Fatalf("confirm r4: %v", err)
	}
	if err := s.Verify(); err != nil {
		t.Fatalf("live store: %v", err)
	}

	replayed, err := Replay(initial, s.Events())
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if err := replayed.Verify(); err != nil {
		t.Fatalf("replayed store: %v", err)
	}

	// Replayed state must match the live store batch by batch.
	for _, name := range []string{"A", "B", "C"} {
		wantT, wantR, wantC, wantA, _ := s.BatchLevel(name)
		gotT, gotR, gotC, gotA, _ := replayed.BatchLevel(name)
		if (wantT != gotT) || (wantR != gotR) || (wantC != gotC) || (wantA != gotA) {
			t.Errorf("batch %s mismatch: live=(%d,%d,%d,%d) replay=(%d,%d,%d,%d)",
				name, wantT, wantR, wantC, wantA, gotT, gotR, gotC, gotA)
		}
		// Per-batch conservation: total == available + reserved + consumed.
		if gotT != gotA+gotR+gotC {
			t.Errorf("batch %s not conserved: total=%d available=%d reserved=%d consumed=%d",
				name, gotT, gotA, gotR, gotC)
		}
	}
	// Reservation states must match too.
	for _, id := range []string{r1.ID, r2.ID, r3.ID, r4.ID} {
		live, _ := s.Reservation(id)
		rep, ok := replayed.Reservation(id)
		if !ok || !reflect.DeepEqual(live, rep) {
			t.Errorf("reservation %s mismatch: live=%+v replay=%+v", id, live, rep)
		}
	}
}
