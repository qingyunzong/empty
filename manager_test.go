package formal

import (
	"context"
	"errors"
	"testing"
	"time"
)

func mustBegin(t *testing.T, m *Manager, options TxOptions) *Transaction {
	t.Helper()
	tx, err := m.Begin(options)
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}
	return tx
}

func mustRead(t *testing.T, m *Manager, tx *Transaction, key string) {
	t.Helper()
	if err := m.Read(tx, key); err != nil {
		t.Fatalf("Read(%s): %v", key, err)
	}
}

func mustWrite(t *testing.T, m *Manager, tx *Transaction, key string) {
	t.Helper()
	if err := m.Write(tx, key); err != nil {
		t.Fatalf("Write(%s): %v", key, err)
	}
}

func TestWriteSkewAbortsDeterministicVictim(t *testing.T) {
	m := NewManager()
	t1 := mustBegin(t, m, TxOptions{})
	t2 := mustBegin(t, m, TxOptions{})

	mustRead(t, m, t1, "x")
	mustRead(t, m, t2, "y")
	mustWrite(t, m, t1, "y")
	mustWrite(t, m, t2, "x")

	if decision := m.Commit(t1); !decision.Committed {
		t.Fatalf("first commit was rejected: %+v", decision)
	}
	decision := m.Commit(t2)
	if decision.Committed {
		t.Fatalf("write skew committed: %+v", decision)
	}
	if decision.Victim != t2.ID {
		t.Fatalf("victim = %d, want pivot %d", decision.Victim, t2.ID)
	}
	if len(decision.Structures) != 1 {
		t.Fatalf("structures = %+v, want one", decision.Structures)
	}
	if got := decision.Structures[0]; got.In != t1.ID || got.Pivot != t2.ID || got.Out != t1.ID {
		t.Fatalf("structure = %+v", got)
	}
	if t2.Status() != StatusAborted {
		t.Fatalf("victim status = %s", t2.Status())
	}
}

func TestNonOverlappingWriteSkewCommits(t *testing.T) {
	m := NewManager()
	t1 := mustBegin(t, m, TxOptions{})
	mustRead(t, m, t1, "x")
	mustWrite(t, m, t1, "y")
	if decision := m.Commit(t1); !decision.Committed {
		t.Fatalf("t1 commit: %+v", decision)
	}

	t2 := mustBegin(t, m, TxOptions{})
	mustRead(t, m, t2, "y")
	mustWrite(t, m, t2, "x")
	if decision := m.Commit(t2); !decision.Committed {
		t.Fatalf("serial t2 commit: %+v", decision)
	}
}

func TestCrossGenerationEdgeRetainsCommittedReader(t *testing.T) {
	m := NewManager()

	t1 := mustBegin(t, m, TxOptions{})
	mustRead(t, m, t1, "x")

	pivot := mustBegin(t, m, TxOptions{})
	mustRead(t, m, pivot, "y")

	out := mustBegin(t, m, TxOptions{})
	mustWrite(t, m, out, "y")
	if decision := m.Commit(out); !decision.Committed {
		t.Fatalf("out commit: %+v", decision)
	}

	// This edge starts at a transaction that commits before the pivot. It must
	// survive t1's commit because the pivot is still active.
	mustWrite(t, m, pivot, "x")
	if decision := m.Commit(t1); !decision.Committed {
		t.Fatalf("reader commit: %+v", decision)
	}
	if stats := m.Stats(); stats.LiveEdges != 2 {
		t.Fatalf("live edges after reader commit = %d, want 2 (cross-generation)", stats.LiveEdges)
	}

	decision := m.Commit(pivot)
	if decision.Committed {
		t.Fatalf("cross-generation dangerous structure committed: %+v", decision)
	}
	if decision.Victim != pivot.ID {
		t.Fatalf("victim = %d, want %d", decision.Victim, pivot.ID)
	}
	if stats := m.Stats(); stats.LiveEdges != 0 || stats.LiveKeyAccesses != 0 {
		t.Fatalf("state not reclaimed: %+v", stats)
	}
}

func TestCommittedReaderAccessRetainedForLaterWrite(t *testing.T) {
	m := NewManager()

	reader := mustBegin(t, m, TxOptions{})
	mustRead(t, m, reader, "x")

	pivot := mustBegin(t, m, TxOptions{})
	mustRead(t, m, pivot, "y")

	out := mustBegin(t, m, TxOptions{})
	mustWrite(t, m, out, "y")
	if decision := m.Commit(out); !decision.Committed {
		t.Fatalf("out commit: %+v", decision)
	}

	if decision := m.Commit(reader); !decision.Committed {
		t.Fatalf("reader commit: %+v", decision)
	}
	if stats := m.Stats(); stats.LiveEdges != 1 {
		t.Fatalf("edges after reader commit = %+v, want pivot out-edge only", stats)
	}

	// The reader has already committed. Its key-read record must survive long
	// enough for this write to publish reader ->rw pivot.
	mustWrite(t, m, pivot, "x")
	if stats := m.Stats(); stats.LiveEdges != 2 {
		t.Fatalf("edges after late write = %+v, want two", stats)
	}

	decision := m.Commit(pivot)
	if decision.Committed {
		t.Fatalf("committed across retained reader dependency: %+v", decision)
	}
	if decision.Victim != pivot.ID {
		t.Fatalf("victim = %d, want %d", decision.Victim, pivot.ID)
	}
}

func TestLateEdgeIntoCommittedPivot(t *testing.T) {
	m := NewManager()

	t0 := mustBegin(t, m, TxOptions{})
	mustRead(t, m, t0, "a")
	mustWrite(t, m, t0, "b")

	t1 := mustBegin(t, m, TxOptions{})
	mustRead(t, m, t1, "b")
	if decision := m.Commit(t0); !decision.Committed {
		t.Fatalf("t0 commit: %+v", decision)
	}

	t2 := mustBegin(t, m, TxOptions{})
	mustWrite(t, m, t1, "c")
	if decision := m.Commit(t1); !decision.Committed {
		t.Fatalf("t1 commit: %+v", decision)
	}
	if stats := m.Stats(); stats.LiveEdges != 1 {
		t.Fatalf("committed pivot out-edge was reclaimed too early: %+v", stats)
	}

	// t2's snapshot predates t1's commit, so this read publishes t2 ->rw t1
	// only after t1 (the pivot) has already committed.
	mustRead(t, m, t2, "c")
	mustWrite(t, m, t2, "a")
	decision := m.Commit(t2)
	if decision.Committed {
		t.Fatalf("late cross-generation cycle committed: %+v", decision)
	}
	if decision.Victim != t2.ID {
		t.Fatalf("victim = %d, want %d", decision.Victim, t2.ID)
	}
	if stats := m.Stats(); stats.LiveEdges != 0 || stats.LiveKeyAccesses != 0 {
		t.Fatalf("state not reclaimed: %+v", stats)
	}
}

func TestVictimPolicyChoosesLowestActiveParticipant(t *testing.T) {
	m := NewManager(WithVictimPolicy(VictimLowestID))

	reader := mustBegin(t, m, TxOptions{})
	mustRead(t, m, reader, "x")

	pivot := mustBegin(t, m, TxOptions{})
	mustRead(t, m, pivot, "y")

	out := mustBegin(t, m, TxOptions{})
	mustWrite(t, m, out, "y")
	if decision := m.Commit(out); !decision.Committed {
		t.Fatalf("out commit: %+v", decision)
	}

	mustWrite(t, m, pivot, "x")
	decision := m.Commit(pivot)
	if !decision.Committed {
		t.Fatalf("pivot commit: %+v", decision)
	}
	if decision.Victim != reader.ID {
		t.Fatalf("victim = %d, want lowest id %d", decision.Victim, reader.ID)
	}
	if reader.Status() != StatusAborted {
		t.Fatalf("reader status = %s", reader.Status())
	}

	if stats := m.Stats(); stats.LiveEdges != 0 || stats.LiveKeyAccesses != 0 {
		t.Fatalf("state not reclaimed: %+v", stats)
	}
}

func TestVictimPolicyChoosesHighestActiveParticipant(t *testing.T) {
	m := NewManager(WithVictimPolicy(VictimHighestID))

	pivot := mustBegin(t, m, TxOptions{})
	mustRead(t, m, pivot, "y")

	out := mustBegin(t, m, TxOptions{})
	mustWrite(t, m, out, "y")
	if decision := m.Commit(out); !decision.Committed {
		t.Fatalf("out commit: %+v", decision)
	}

	reader := mustBegin(t, m, TxOptions{})
	mustRead(t, m, reader, "x")
	mustWrite(t, m, pivot, "x")

	decision := m.Commit(pivot)
	if !decision.Committed {
		t.Fatalf("pivot commit: %+v", decision)
	}
	if decision.Victim != reader.ID {
		t.Fatalf("victim = %d, want highest id %d", decision.Victim, reader.ID)
	}
	if reader.Status() != StatusAborted {
		t.Fatalf("reader status = %s", reader.Status())
	}
}

func TestWriteWriteConflictFirstCommitterWins(t *testing.T) {
	m := NewManager()
	t1 := mustBegin(t, m, TxOptions{})
	t2 := mustBegin(t, m, TxOptions{})

	mustWrite(t, m, t1, "x")
	mustWrite(t, m, t2, "x")

	if decision := m.Commit(t1); !decision.Committed {
		t.Fatalf("first writer: %+v", decision)
	}
	decision := m.Commit(t2)
	if decision.Committed || decision.Victim != t2.ID {
		t.Fatalf("write-write conflict decision = %+v", decision)
	}
	if stats := m.Stats(); stats.WriteConflicts != 1 {
		t.Fatalf("write conflicts = %d", stats.WriteConflicts)
	}
}

func TestReadOnlySafeSnapshot(t *testing.T) {
	m := NewManager()

	if snapshot, ok := m.SafeSnapshot(); !ok || !snapshot.Safe {
		t.Fatalf("initial safe snapshot = %+v, %t", snapshot, ok)
	}

	rw := mustBegin(t, m, TxOptions{})
	if _, ok := m.SafeSnapshot(); ok {
		t.Fatal("safe snapshot reported while a read-write transaction is active")
	}
	ro, err := m.Begin(TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if ro.Snapshot.Safe {
		t.Fatal("read-only snapshot concurrent with a writer marked safe")
	}

	if err := m.Write(ro, "x"); !errors.Is(err, ErrReadOnlyWrite) {
		t.Fatalf("read-only write error = %v", err)
	}
	if err := m.Commit(rw); !err.Committed {
		t.Fatalf("rw commit: %+v", err)
	}
	if err := m.Commit(ro); !err.Committed {
		t.Fatalf("ro commit: %+v", err)
	}
}

func TestDeferrableReadOnlyWaitsForSafeSnapshot(t *testing.T) {
	m := NewManager()
	rw := mustBegin(t, m, TxOptions{})

	type beginResult struct {
		tx  *Transaction
		err error
	}
	resultCh := make(chan beginResult, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		tx, err := m.BeginContext(ctx, TxOptions{ReadOnly: true, Deferrable: true})
		resultCh <- beginResult{tx: tx, err: err}
	}()

	select {
	case got := <-resultCh:
		t.Fatalf("deferrable transaction did not wait: %+v", got)
	case <-time.After(20 * time.Millisecond):
	}

	if decision := m.Commit(rw); !decision.Committed {
		t.Fatalf("rw commit: %+v", decision)
	}
	result := <-resultCh
	if result.err != nil {
		t.Fatalf("deferrable begin: %v", result.err)
	}
	if !result.tx.Snapshot.Safe {
		t.Fatalf("snapshot not safe: %+v", result.tx.Snapshot)
	}
	if decision := m.Commit(result.tx); !decision.Committed {
		t.Fatalf("ro commit: %+v", decision)
	}
}

func TestDeferrableReadOnlyHonorsCanceledContext(t *testing.T) {
	m := NewManager()
	rw := mustBegin(t, m, TxOptions{})
	defer m.Abort(rw)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := m.BeginContext(ctx, TxOptions{ReadOnly: true, Deferrable: true}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled begin error = %v", err)
	}
}

func TestSafeReadOnlySourceDoesNotCreateDangerousStructure(t *testing.T) {
	m := NewManager()

	ro := mustBegin(t, m, TxOptions{ReadOnly: true})
	if !ro.Snapshot.Safe {
		t.Fatal("expected safe snapshot")
	}
	mustRead(t, m, ro, "x")

	pivot := mustBegin(t, m, TxOptions{})
	mustRead(t, m, pivot, "y")

	out := mustBegin(t, m, TxOptions{})
	mustWrite(t, m, out, "y")
	if decision := m.Commit(out); !decision.Committed {
		t.Fatalf("out commit: %+v", decision)
	}

	mustWrite(t, m, pivot, "x")
	if decision := m.Commit(pivot); !decision.Committed || decision.Victim != 0 {
		t.Fatalf("safe read-only source caused an abort: %+v", decision)
	}
	if decision := m.Commit(ro); !decision.Committed {
		t.Fatalf("ro commit: %+v", decision)
	}
}

func TestIncrementalReclamationAcrossGenerations(t *testing.T) {
	m := NewManager()

	for i := 0; i < 500; i++ {
		old := mustBegin(t, m, TxOptions{})
		mustRead(t, m, old, "hot")

		next := mustBegin(t, m, TxOptions{})
		mustRead(t, m, next, "hot")
		mustWrite(t, m, next, "hot")

		if decision := m.Commit(old); !decision.Committed {
			t.Fatalf("generation %d old commit: %+v", i, decision)
		}
		if decision := m.Commit(next); !decision.Committed {
			t.Fatalf("generation %d next commit: %+v", i, decision)
		}

		if stats := m.Stats(); stats.LiveEdges != 0 || stats.LiveKeyAccesses != 0 {
			t.Fatalf("generation %d leaked state: %+v", i, stats)
		}
	}

	stats := m.Stats()
	if stats.EdgesCreated != stats.EdgesReclaimed {
		t.Fatalf("edges created/reclaimed = %d/%d", stats.EdgesCreated, stats.EdgesReclaimed)
	}
}
