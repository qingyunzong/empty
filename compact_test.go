package logcompact_test

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"logcompact"
)

// buildScenario creates:
//
//	txn1: Begin(1) Update a=one(2) Commit(3)
//	txn2: Begin(4) Update a=two(5) Update b=one(6) Commit(7)
//	txn3: Begin(8) Update b=two(9)                     (pending)
//	txn4: Begin(10) Update a=three(11) Abort(12)       (aborts above horizon)
func buildScenario(t *testing.T) (*logcompact.Log, []logcompact.Record) {
	t.Helper()
	l := logcompact.New()
	var full []logcompact.Record
	add := func(rec logcompact.Record, err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		full = append(full, rec)
	}
	txn1, rec := l.Begin()
	full = append(full, rec)
	add(l.Update(txn1, "a", "one"))
	add(l.Commit(txn1))
	txn2, rec := l.Begin()
	full = append(full, rec)
	add(l.Update(txn2, "a", "two"))
	add(l.Update(txn2, "b", "one"))
	add(l.Commit(txn2))
	txn3, rec := l.Begin()
	full = append(full, rec)
	add(l.Update(txn3, "b", "two"))
	txn4, rec := l.Begin()
	full = append(full, rec)
	add(l.Update(txn4, "a", "three"))
	add(l.Abort(txn4))
	return l, full
}

func TestCompactRetentionReasons(t *testing.T) {
	l, full := buildScenario(t)
	reg := logcompact.NewReaderRegistry()
	reader := reg.Acquire(3) // pins snapshot at txn1's commit

	rep, err := l.Compact(7, reg)
	if err != nil {
		t.Fatal(err)
	}

	wantReasons := map[uint64]logcompact.Reason{
		2:  logcompact.ReasonActiveReader,
		3:  logcompact.ReasonCommitMarker,
		5:  logcompact.ReasonCheckpointBase,
		6:  logcompact.ReasonCheckpointBase,
		7:  logcompact.ReasonCommitMarker,
		8:  logcompact.ReasonPendingTxnRecovery | logcompact.ReasonBeyondHorizon,
		9:  logcompact.ReasonPendingTxnRecovery | logcompact.ReasonBeyondHorizon,
		10: logcompact.ReasonPendingTxnRecovery | logcompact.ReasonBeyondHorizon,
		11: logcompact.ReasonPendingTxnRecovery | logcompact.ReasonBeyondHorizon,
		12: logcompact.ReasonPendingTxnRecovery | logcompact.ReasonBeyondHorizon,
	}
	if len(rep.Kept) != len(wantReasons) {
		t.Fatalf("kept %d records, want %d\n%s", len(rep.Kept), len(wantReasons), rep.String())
	}
	for _, k := range rep.Kept {
		want, ok := wantReasons[k.Record.LSN]
		if !ok {
			t.Fatalf("unexpected kept record %+v", k.Record)
		}
		if k.Reasons != want {
			t.Fatalf("lsn=%d reasons = %s, want %s", k.Record.LSN, k.Reasons, want)
		}
	}
	var dropped []uint64
	for _, d := range rep.Dropped {
		dropped = append(dropped, d.LSN)
	}
	if !reflect.DeepEqual(dropped, []uint64{1, 4}) {
		t.Fatalf("dropped = %v, want [1 4]", dropped)
	}

	// Recovery from the compacted log must match the full log.
	got := logcompact.Recover(l.Records())
	want := logcompact.Recover(full)
	if !reflect.DeepEqual(got.State, want.State) {
		t.Fatalf("state = %v, want %v", got.State, want.State)
	}
	if !reflect.DeepEqual(got.Pending, want.Pending) {
		t.Fatalf("pending mismatch:\n got %v\nwant %v", got.Pending, want.Pending)
	}
	// The active reader's snapshot must still be servable.
	gotSnap := logcompact.ReadSnapshot(l.Records(), reader.Snapshot)
	wantSnap := logcompact.ReadSnapshot(full, reader.Snapshot)
	if !reflect.DeepEqual(gotSnap, wantSnap) {
		t.Fatalf("reader snapshot = %v, want %v", gotSnap, wantSnap)
	}

	// Report output must name the reason for every retained record.
	out := rep.String()
	for _, kw := range []string{"active-reader", "checkpoint-base", "commit-marker", "pending-txn-recovery", "beyond-horizon"} {
		if !strings.Contains(out, kw) {
			t.Fatalf("report missing %q:\n%s", kw, out)
		}
	}
}

func TestCompactAfterReaderRelease(t *testing.T) {
	l, full := buildScenario(t)
	reg := logcompact.NewReaderRegistry()
	reader := reg.Acquire(3)
	if _, err := l.Compact(7, reg); err != nil {
		t.Fatal(err)
	}
	if err := reg.Release(reader); err != nil {
		t.Fatal(err)
	}

	rep, err := l.Compact(7, reg)
	if err != nil {
		t.Fatal(err)
	}
	// Without the reader, lsn 2 and its commit marker 3 are no longer needed.
	var kept []uint64
	for _, k := range rep.Kept {
		kept = append(kept, k.Record.LSN)
	}
	want := []uint64{5, 6, 7, 8, 9, 10, 11, 12}
	if !reflect.DeepEqual(kept, want) {
		t.Fatalf("kept = %v, want %v", kept, want)
	}
	got := logcompact.Recover(l.Records())
	if wantRec := logcompact.Recover(full); !reflect.DeepEqual(got.State, wantRec.State) {
		t.Fatalf("state = %v, want %v", got.State, wantRec.State)
	}
}

func TestCompactAdvancesWithCommits(t *testing.T) {
	l, full := buildScenario(t)
	reg := logcompact.NewReaderRegistry()
	if _, err := l.Compact(7, reg); err != nil {
		t.Fatal(err)
	}
	// Commit the pending txn3, then compact to the new commit version.
	txn3 := uint64(3)
	if _, err := l.Commit(txn3); err != nil {
		t.Fatal(err)
	}
	rep, err := l.Compact(13, reg)
	if err != nil {
		t.Fatal(err)
	}
	var kept []uint64
	for _, k := range rep.Kept {
		kept = append(kept, k.Record.LSN)
	}
	// Checkpoint base at 13: a -> lsn 5 (txn2), b -> lsn 9 (txn3);
	// commit markers 7 and 13. Everything else is resolved and stale.
	want := []uint64{5, 7, 9, 13}
	if !reflect.DeepEqual(kept, want) {
		t.Fatalf("kept = %v, want %v\n%s", kept, want, rep.String())
	}
	full = append(full, logcompact.Record{LSN: 13, TxnID: 3, Type: logcompact.CommitRecord, PrevLSN: 9})
	got := logcompact.Recover(l.Records())
	if wantRec := logcompact.Recover(full); !reflect.DeepEqual(got.State, wantRec.State) {
		t.Fatalf("state = %v, want %v", got.State, wantRec.State)
	}
}

func TestCompactInvalidHorizon(t *testing.T) {
	l, _ := buildScenario(t)
	if _, err := l.Compact(0, nil); !errors.Is(err, logcompact.ErrInvalidHorizon) {
		t.Fatalf("horizon 0: %v", err)
	}
	if _, err := l.Compact(6, nil); !errors.Is(err, logcompact.ErrInvalidHorizon) {
		t.Fatalf("non-commit horizon: %v", err)
	}
	if _, err := l.Compact(7, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Compact(3, nil); !errors.Is(err, logcompact.ErrInvalidHorizon) {
		t.Fatalf("backwards horizon: %v", err)
	}
}

func ExampleLog_Compact() {
	l := logcompact.New()
	txn1, _ := l.Begin()
	l.Update(txn1, "x", "a")
	l.Commit(txn1)
	txn2, _ := l.Begin()
	l.Update(txn2, "x", "b")
	commit, _ := l.Commit(txn2)

	rep, _ := l.Compact(commit.LSN, nil)
	fmt.Print(rep.String())
	fmt.Println("recovered:", logcompact.Recover(l.Records()).State)

	// Output:
	// horizon=6 kept=2 dropped=4
	// keep lsn=5 txn=2 type=Update key=x value=b reasons=checkpoint-base
	// keep lsn=6 txn=2 type=Commit reasons=commit-marker
	// drop lsn=1 txn=1 type=Begin
	// drop lsn=2 txn=1 type=Update key=x value=a
	// drop lsn=3 txn=1 type=Commit
	// drop lsn=4 txn=2 type=Begin
	// recovered: map[x:b]
}
