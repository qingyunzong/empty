package delivery

import (
	"context"
	"errors"
	"testing"
)

func TestLateDispositionFencedByEpoch(t *testing.T) {
	ctx := context.Background()
	tracker, store := newTestTracker(t)

	if _, err := tracker.Incoming(ctx, "tag-c", 1); err != nil {
		t.Fatalf("Incoming: %v", err)
	}
	epoch2, err := tracker.BeginGeneration(ctx)
	if err != nil || epoch2 != 2 {
		t.Fatalf("second generation = %d, %v", epoch2, err)
	}

	// A disposition still carrying the retired epoch must be rejected and
	// must not mutate the record.
	if _, err := tracker.Disposition(ctx, 1, "tag-c", OutcomeAccepted, true); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale disposition = %v, want ErrStaleGeneration", err)
	}
	rec, _ := store.Get(ctx, "tag-c")
	if rec.Settled || rec.Outcome != OutcomeNone {
		t.Fatalf("stale disposition mutated record: %+v", rec)
	}

	// Redelivery on the new generation re-registers the same tag without
	// re-writing business data.
	redelivered, err := tracker.Incoming(ctx, "tag-c", 200)
	if err != nil || !redelivered.Duplicate || redelivered.Record.LinkEpoch != 2 {
		t.Fatalf("redelivery = %+v, %v", redelivered, err)
	}
	if _, err := tracker.Disposition(ctx, epoch2, "tag-c", OutcomeAccepted, true); err != nil {
		t.Fatalf("current-epoch disposition: %v", err)
	}
	if _, err := tracker.Disposition(ctx, epoch2, "tag-c", OutcomeModified, true); !errors.Is(err, ErrAlreadySettled) {
		t.Fatalf("double settle = %v, want ErrAlreadySettled", err)
	}
	rec, _ = store.Get(ctx, "tag-c")
	if !rec.Settled || rec.Outcome != OutcomeAccepted {
		t.Fatalf("settled record = %+v", rec)
	}

	if _, err := tracker.Disposition(ctx, epoch2, "nope", OutcomeAccepted, true); !errors.Is(err, ErrUnknownDelivery) {
		t.Fatalf("unknown tag = %v, want ErrUnknownDelivery", err)
	}
}

func TestInterimDispositionStaysUnsettled(t *testing.T) {
	ctx := context.Background()
	tracker, _ := newTestTracker(t)

	if _, err := tracker.Incoming(ctx, "d", 1); err != nil {
		t.Fatal(err)
	}
	rec, err := tracker.Disposition(ctx, 1, "d", OutcomeModified, false)
	if err != nil {
		t.Fatalf("interim disposition: %v", err)
	}
	if rec.Settled || rec.Outcome != OutcomeModified {
		t.Fatalf("interim record = %+v", rec)
	}
	unsettled, _ := tracker.Reconcile(ctx)
	if len(unsettled) != 1 {
		t.Fatalf("interim disposition must stay in unsettled map: %+v", unsettled)
	}
	rec, err = tracker.Disposition(ctx, 1, "d", OutcomeAccepted, true)
	if err != nil || !rec.Settled {
		t.Fatalf("settling disposition = %+v, %v", rec, err)
	}
	if recs, _ := tracker.Reconcile(ctx); len(recs) != 0 {
		t.Fatalf("settled delivery must leave the map: %+v", recs)
	}
}

func TestReconcileAfterReconnectAndRestart(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	tracker, err := NewTracker(ctx, store)
	if err != nil {
		t.Fatalf("NewTracker: %v", err)
	}
	epoch1, _ := tracker.BeginGeneration(ctx)
	if _, err := tracker.Incoming(ctx, "a", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := tracker.Incoming(ctx, "b", 2); err != nil {
		t.Fatal(err)
	}
	if _, err := tracker.Disposition(ctx, epoch1, "b", OutcomeAccepted, true); err != nil {
		t.Fatal(err)
	}

	// Simulate process restart: rebuild tracker from the durable store.
	restarted, err := NewTracker(ctx, store)
	if err != nil {
		t.Fatalf("restart NewTracker: %v", err)
	}
	if restarted.CurrentEpoch() != 1 {
		t.Fatalf("restored epoch = %d, want 1", restarted.CurrentEpoch())
	}
	epoch2, err := restarted.BeginGeneration(ctx)
	if err != nil || epoch2 != 2 {
		t.Fatalf("post-restart generation = %d, %v", epoch2, err)
	}

	unsettled, err := restarted.Reconcile(ctx)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if len(unsettled) != 1 || unsettled[0].Tag != "a" {
		t.Fatalf("unsettled map = %+v, want only a", unsettled)
	}
	if _, err := restarted.Resume(ctx, "missing", 50); !errors.Is(err, ErrUnknownDelivery) {
		t.Fatalf("Resume missing = %v, want ErrUnknownDelivery", err)
	}
	resumed, err := restarted.Resume(ctx, "a", 50)
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if resumed.LinkEpoch != 2 || resumed.DeliveryID != 50 {
		t.Fatalf("resumed record = %+v", resumed)
	}
}
