package logcompact_test

import (
	"errors"
	"testing"

	"logcompact"
)

func TestBasicTxnLifecycle(t *testing.T) {
	l := logcompact.New()
	txn1, begin := l.Begin()
	if begin.LSN != 1 || begin.Type != logcompact.BeginRecord || begin.PrevLSN != 0 {
		t.Fatalf("unexpected begin record: %+v", begin)
	}
	upd, err := l.Update(txn1, "k", "v1")
	if err != nil {
		t.Fatal(err)
	}
	if upd.PrevLSN != begin.LSN {
		t.Fatalf("update PrevLSN = %d, want %d", upd.PrevLSN, begin.LSN)
	}
	commit, err := l.Commit(txn1)
	if err != nil {
		t.Fatal(err)
	}
	if commit.PrevLSN != upd.LSN {
		t.Fatalf("commit PrevLSN = %d, want %d", commit.PrevLSN, upd.LSN)
	}
	if l.MaxCommit() != commit.LSN {
		t.Fatalf("MaxCommit = %d, want %d", l.MaxCommit(), commit.LSN)
	}

	rec := logcompact.Recover(l.Records())
	if rec.State["k"] != "v1" {
		t.Fatalf("recovered state = %v", rec.State)
	}
	if len(rec.Pending) != 0 {
		t.Fatalf("unexpected pending txns: %v", rec.Pending)
	}
}

func TestAbortedTxnNotApplied(t *testing.T) {
	l := logcompact.New()
	txn1, _ := l.Begin()
	if _, err := l.Update(txn1, "k", "good"); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Commit(txn1); err != nil {
		t.Fatal(err)
	}
	txn2, _ := l.Begin()
	if _, err := l.Update(txn2, "k", "bad"); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Abort(txn2); err != nil {
		t.Fatal(err)
	}

	rec := logcompact.Recover(l.Records())
	if rec.State["k"] != "good" {
		t.Fatalf("recovered state = %v, want k=good", rec.State)
	}
}

func TestPendingTxnChainPreserved(t *testing.T) {
	l := logcompact.New()
	txn1, _ := l.Begin()
	if _, err := l.Update(txn1, "a", "1"); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Update(txn1, "b", "2"); err != nil {
		t.Fatal(err)
	}

	rec := logcompact.Recover(l.Records())
	chain := rec.Pending[txn1]
	if len(chain) != 3 {
		t.Fatalf("pending chain len = %d, want 3", len(chain))
	}
	for i := 1; i < len(chain); i++ {
		if chain[i].PrevLSN != chain[i-1].LSN {
			t.Fatalf("broken PrevLSN chain at %d: %+v", i, chain)
		}
	}
}

func TestTxnStateErrors(t *testing.T) {
	l := logcompact.New()
	if _, err := l.Update(999, "k", "v"); !errors.Is(err, logcompact.ErrUnknownTxn) {
		t.Fatalf("update unknown txn: %v", err)
	}
	txn1, _ := l.Begin()
	if _, err := l.Commit(txn1); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Update(txn1, "k", "v"); !errors.Is(err, logcompact.ErrTxnNotActive) {
		t.Fatalf("update after commit: %v", err)
	}
	if _, err := l.Commit(txn1); !errors.Is(err, logcompact.ErrTxnNotActive) {
		t.Fatalf("double commit: %v", err)
	}
	if _, err := l.Abort(txn1); !errors.Is(err, logcompact.ErrTxnNotActive) {
		t.Fatalf("abort after commit: %v", err)
	}
}
