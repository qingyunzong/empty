package delivery

import (
	"context"
	"errors"
	"testing"
)

func TestTransactionCommitOutcome(t *testing.T) {
	ctx := context.Background()
	tracker, _ := newTestTracker(t)
	db := newFakeDB()

	if _, err := tracker.Incoming(ctx, "tx-1", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := tracker.Incoming(ctx, "tx-2", 2); err != nil {
		t.Fatal(err)
	}
	txnID, rec, err := tracker.Enlist(ctx, "tx-1", "")
	if err != nil || txnID == "" || rec.TxnID != txnID {
		t.Fatalf("Enlist = %q, %+v, %v", txnID, rec, err)
	}
	if _, _, err := tracker.Enlist(ctx, "tx-2", txnID); err != nil {
		t.Fatalf("Enlist second: %v", err)
	}
	// No outcome before discharge and no direct commit of enlisted work.
	if rec.Outcome != OutcomeNone {
		t.Fatalf("enlisted record already has outcome: %+v", rec)
	}
	if _, err := tracker.Commit(ctx, "tx-1", db.commit); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("transactional Commit = %v, want ErrInvalidState", err)
	}
	if db.writes() != 0 {
		t.Fatalf("writes before discharge = %d, want 0", db.writes())
	}

	committed, err := tracker.DischargeTxn(ctx, txnID, true, db.commit)
	if err != nil {
		t.Fatalf("DischargeTxn commit: %v", err)
	}
	if len(committed) != 2 || db.writes() != 2 {
		t.Fatalf("discharge = %+v, writes=%d", committed, db.writes())
	}
	for _, rec := range committed {
		if rec.Outcome != OutcomeAccepted || rec.Settled || rec.TxnID == "" {
			t.Fatalf("committed txn record = %+v", rec)
		}
	}

	// Accepted but not yet settled: still in the reconciliation map.
	if recs, _ := tracker.Reconcile(ctx); len(recs) != 2 {
		t.Fatalf("Reconcile after commit = %+v", recs)
	}
	if _, err := tracker.Disposition(ctx, tracker.CurrentEpoch(), "tx-1", OutcomeAccepted, true); err != nil {
		t.Fatal(err)
	}
	if recs, _ := tracker.Reconcile(ctx); len(recs) != 1 || recs[0].Tag != "tx-2" {
		t.Fatalf("Reconcile after settle = %+v", recs)
	}

	if _, _, err := tracker.Enlist(ctx, "ghost", "ignored"); !errors.Is(err, ErrUnknownDelivery) {
		t.Fatalf("Enlist missing = %v, want ErrUnknownDelivery", err)
	}
}

func TestTransactionRollbackRedelivery(t *testing.T) {
	ctx := context.Background()
	tracker, store := newTestTracker(t)
	db := newFakeDB()

	if _, err := tracker.Incoming(ctx, "rb", 1); err != nil {
		t.Fatal(err)
	}
	txnID, _, err := tracker.Enlist(ctx, "rb", "")
	if err != nil {
		t.Fatal(err)
	}
	rolled, err := tracker.DischargeTxn(ctx, txnID, false, db.commit)
	if err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if len(rolled) != 1 || rolled[0].TxnID != "" || rolled[0].Outcome != OutcomeNone {
		t.Fatalf("rolled-back record = %+v", rolled)
	}
	if db.writes() != 0 {
		t.Fatalf("rollback wrote %d times", db.writes())
	}
	if _, err := tracker.DischargeTxn(ctx, txnID, false, db.commit); !errors.Is(err, ErrUnknownTransaction) {
		t.Fatalf("discharge released txn = %v, want ErrUnknownTransaction", err)
	}

	unsettled, _ := tracker.Reconcile(ctx)
	if len(unsettled) != 1 || unsettled[0].Tag != "rb" {
		t.Fatalf("unsettled after rollback = %+v", unsettled)
	}
	rec, err := tracker.Commit(ctx, "rb", db.commit)
	if err != nil || !rec.Committed || rec.Outcome != OutcomeAccepted {
		t.Fatalf("post-rollback commit = %+v, %v", rec, err)
	}
	rec, _ = store.Get(ctx, "rb")
	if rec.Settled {
		t.Fatal("accepted without peer disposition must remain unsettled")
	}
}

func TestTransactionRestoredOnRestart(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	tracker, err := NewTracker(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tracker.BeginGeneration(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := tracker.Incoming(ctx, "k", 1); err != nil {
		t.Fatal(err)
	}
	txnID, _, err := tracker.Enlist(ctx, "k", "durable-txn")
	if err != nil {
		t.Fatal(err)
	}

	restarted, err := NewTracker(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	db := newFakeDB()
	committed, err := restarted.DischargeTxn(ctx, txnID, true, db.commit)
	if err != nil {
		t.Fatalf("discharge after restart: %v", err)
	}
	if len(committed) != 1 || committed[0].Outcome != OutcomeAccepted {
		t.Fatalf("restarted discharge = %+v", committed)
	}
}
