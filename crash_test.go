package formal

import (
	"context"
	"errors"
	"testing"
)

var errInjectedCrash = errors.New("injected crash")

func crashOnce(point CrashPoint) (CheckpointFunc, *bool) {
	fired := false
	return func(got CrashPoint) error {
		if !fired && got == point {
			fired = true
			return errInjectedCrash
		}
		return nil
	}, &fired
}

func testRecords() []Record {
	return []Record{
		{ID: "out-1", Data: []byte("one")},
		{ID: "out-2", Data: []byte("two")},
	}
}

func TestCrashPointEnumerationReplaysExactlyOnce(t *testing.T) {
	commitPathPoints := []CrashPoint{
		CrashAfterBeginLog,
		CrashAfterPrepareLog,
		CrashAfterCommitLog,
		CrashAfterCommitVisible,
		CrashAfterSinkApply,
		CrashAfterAckLog,
	}

	for _, point := range commitPathPoints {
		point := point
		t.Run(point.String(), func(t *testing.T) {
			dir := t.TempDir()
			sink := NewMemorySink()
			checkpoint, fired := crashOnce(point)
			c, err := Open(dir, WithSink(sink), WithCheckpoint(checkpoint))
			if err != nil {
				t.Fatalf("Open: %v", err)
			}

			var gotReceipt Receipt
			var opErr error
			tx, err := c.Begin(context.Background(), "txn")
			if err != nil {
				opErr = err
			} else {
				if err := tx.Append(testRecords()...); err != nil {
					t.Fatalf("Append: %v", err)
				}
				if _, err := tx.Prepare(context.Background()); err != nil {
					opErr = err
				} else {
					gotReceipt, opErr = tx.Commit(context.Background())
				}
			}
			if !errors.Is(opErr, ErrCrash) {
				t.Fatalf("operation error = %v, want injected crash", opErr)
			}
			if !*fired {
				t.Fatalf("checkpoint %s never fired", point)
			}
			if err := c.Close(); err != nil {
				t.Fatalf("Close crashed coordinator: %v", err)
			}

			c2, err := Open(dir, WithSink(sink))
			if err != nil {
				t.Fatalf("reopen: %v", err)
			}
			defer c2.Close()

			commitDurable := false
			switch point {
			case CrashAfterBeginLog:
				if _, ok := c2.Result("txn"); ok {
					t.Fatal("open transaction should have no durable result")
				}
			case CrashAfterPrepareLog:
				receipt, ok := c2.Result("txn")
				if !ok || receipt.State != TxnPrepared || receipt.PrepareSeq == 0 {
					t.Fatalf("prepared crash should recover as in-flight: %+v, %v", receipt, ok)
				}
			case CrashAfterCommitLog, CrashAfterCommitVisible, CrashAfterSinkApply, CrashAfterAckLog:
				commitDurable = true
			}

			if commitDurable {
				if gotReceipt.State != TxnCommitted || gotReceipt.CommitSeq == 0 {
					t.Fatalf("commit receipt returned across crash = %+v", gotReceipt)
				}
				replayed, ok := c2.Result("txn")
				if !ok || replayed != gotReceipt {
					t.Fatalf("replayed receipt = %+v, %v; want %+v", replayed, ok, gotReceipt)
				}
				assertIDs(t, recordIDs(c2.CommittedRecords()), "out-1", "out-2")
				assertIDs(t, recordIDs(sink.Records()), "out-1", "out-2")

				tx2 := beginTestTxn(t, c2, "txn")
				retried, err := tx2.Commit(context.Background())
				if err != nil {
					t.Fatalf("retry after replay: %v", err)
				}
				if retried != gotReceipt {
					t.Fatalf("retry receipt = %+v, want %+v", retried, gotReceipt)
				}
				if sink.Len() != 1 {
					t.Fatalf("sink deliveries = %d, want 1", sink.Len())
				}
				assertIDs(t, recordIDs(sink.Records()), "out-1", "out-2")
			} else {
				if len(c2.CommittedRecords()) != 0 || sink.Len() != 0 {
					t.Fatalf("non-commit crash exposed data: committed=%v sink=%v",
						c2.CommittedRecords(), sink.Records())
				}
				if point == CrashAfterPrepareLog {
					// The prepared payload survives recovery and can be
					// committed by a retry without re-appending records.
					retry, err := c2.Commit(context.Background(), "txn")
					if err != nil {
						t.Fatalf("retry Commit from prepared recovery: %v", err)
					}
					if retry.State != TxnCommitted {
						t.Fatalf("retry receipt = %+v", retry)
					}
					assertIDs(t, recordIDs(c2.CommittedRecords()), "out-1", "out-2")
					assertIDs(t, recordIDs(sink.Records()), "out-1", "out-2")
					if sink.Len() != 1 {
						t.Fatalf("sink deliveries = %d, want 1", sink.Len())
					}
				}
			}
		})
	}
}

func TestAbortCrashPointReplaysAbortedResult(t *testing.T) {
	dir := t.TempDir()
	sink := NewMemorySink()
	checkpoint, fired := crashOnce(CrashAfterAbortLog)
	c, err := Open(dir, WithSink(sink), WithCheckpoint(checkpoint))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	tx, _ := preparedTestTxn(t, c, "aborted", Record{ID: "never"})
	receipt, err := tx.Abort(context.Background())
	if !errors.Is(err, ErrCrash) {
		t.Fatalf("Abort error = %v, want injected crash", err)
	}
	if !*fired || receipt.State != TxnAborted || receipt.AbortSeq == 0 {
		t.Fatalf("abort receipt = %+v, fired=%v", receipt, *fired)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	c2, err := Open(dir, WithSink(sink))
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer c2.Close()
	replayed, ok := c2.Result("aborted")
	if !ok || replayed != receipt {
		t.Fatalf("replayed abort receipt = %+v, %v; want %+v", replayed, ok, receipt)
	}
	if len(c2.CommittedRecords()) != 0 || sink.Len() != 0 {
		t.Fatal("aborted transaction became visible")
	}
}

func TestPreparedTransactionSurvivesRecoveryUntilCommit(t *testing.T) {
	dir := t.TempDir()
	sink := NewMemorySink()

	checkpoint, _ := crashOnce(CrashAfterPrepareLog)
	c, err := Open(dir, WithSink(sink), WithCheckpoint(checkpoint))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	tx := beginTestTxn(t, c, "prepared", Record{ID: "in-flight"})
	if _, err := tx.Prepare(context.Background()); !errors.Is(err, ErrCrash) {
		t.Fatalf("Prepare error = %v, want injected crash", err)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	c2, err := Open(dir, WithSink(sink))
	if err != nil {
		t.Fatalf("recovery Open: %v", err)
	}
	defer c2.Close()
	receipt, ok := c2.Result("prepared")
	if !ok || receipt.State != TxnPrepared || receipt.CommitSeq != 0 {
		t.Fatalf("recovered prepared result = %+v, %v", receipt, ok)
	}
	if len(c2.CommittedRecords()) != 0 || sink.Len() != 0 {
		t.Fatal("recovered in-flight record became visible")
	}
	if state, ok := c2.State("prepared"); !ok || state != TxnPrepared {
		t.Fatalf("recovered state = %s, %v", state, ok)
	}
	committed, err := c2.Commit(context.Background(), "prepared")
	if err != nil {
		t.Fatalf("Commit recovered prepared transaction: %v", err)
	}
	if committed.State != TxnCommitted || committed.CommitSeq == 0 {
		t.Fatalf("committed receipt = %+v", committed)
	}
	assertIDs(t, recordIDs(c2.CommittedRecords()), "in-flight")
	assertIDs(t, recordIDs(sink.Records()), "in-flight")
}

func TestInterleavedCrashThenRetryDoesNotDuplicate(t *testing.T) {
	dir := t.TempDir()
	sink := NewMemorySink()

	prepareCrash, _ := crashOnce(CrashAfterPrepareLog)
	c1, err := Open(dir, WithSink(sink), WithCheckpoint(prepareCrash))
	if err != nil {
		t.Fatalf("Open first attempt: %v", err)
	}
	tx := beginTestTxn(t, c1, "interleaved",
		Record{ID: "r1", Data: []byte("one")},
		Record{ID: "r2", Data: []byte("two")},
	)
	if _, err := tx.Prepare(context.Background()); !errors.Is(err, ErrCrash) {
		t.Fatalf("Prepare error = %v, want injected crash", err)
	}
	if err := c1.Close(); err != nil {
		t.Fatalf("Close first attempt: %v", err)
	}

	applyCrash, _ := crashOnce(CrashAfterSinkApply)
	c2, err := Open(dir, WithSink(sink), WithCheckpoint(applyCrash))
	if err != nil {
		t.Fatalf("Open second attempt: %v", err)
	}
	receipt, err := c2.Commit(context.Background(), "interleaved")
	if !errors.Is(err, ErrCrash) {
		t.Fatalf("Commit error = %v, want injected crash", err)
	}
	if !receipt.Committed() {
		t.Fatalf("commit decision was not durable: %+v", receipt)
	}
	if sink.Len() != 1 {
		t.Fatalf("first sink application count = %d, want 1", sink.Len())
	}
	if err := c2.Close(); err != nil {
		t.Fatalf("Close second attempt: %v", err)
	}

	c3, err := Open(dir, WithSink(sink))
	if err != nil {
		t.Fatalf("Open recovery: %v", err)
	}
	defer c3.Close()
	replayed, ok := c3.Result("interleaved")
	if !ok || replayed != receipt {
		t.Fatalf("replayed receipt = %+v, %v; want %+v", replayed, ok, receipt)
	}
	retried, err := c3.Commit(context.Background(), "interleaved")
	if err != nil {
		t.Fatalf("retry Commit: %v", err)
	}
	if retried != receipt {
		t.Fatalf("retry receipt = %+v, want %+v", retried, receipt)
	}
	if sink.Len() != 1 {
		t.Fatalf("sink deliveries = %d, want 1", sink.Len())
	}
	assertIDs(t, recordIDs(c3.CommittedRecords()), "r1", "r2")
	assertIDs(t, recordIDs(sink.Records()), "r1", "r2")
}

func TestEveryDeclaredCrashPointIsCovered(t *testing.T) {
	covered := map[CrashPoint]bool{
		CrashAfterBeginLog:      true,
		CrashAfterPrepareLog:    true,
		CrashAfterCommitLog:     true,
		CrashAfterCommitVisible: true,
		CrashAfterSinkApply:     true,
		CrashAfterAckLog:        true,
		CrashAfterAbortLog:      true,
	}
	for _, point := range AllCrashPoints() {
		if !covered[point] {
			t.Fatalf("crash point %s is declared but not covered", point)
		}
	}
}
