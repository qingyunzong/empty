package txcache

import (
	"errors"
	"fmt"
	"testing"
)

// mustGet reads via a handle and fails on error.
func mustGet(t *testing.T, h *Handle) (string, bool) {
	t.Helper()
	v, ok, err := h.Get()
	if err != nil {
		t.Fatalf("Get: unexpected error %v", err)
	}
	return v, ok
}

func TestCommitRejectsHandles(t *testing.T) {
	c := New()
	tx := c.Begin()
	h := tx.Handle("k")
	if err := h.Set("v1"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if v, ok := c.Get("k"); v != "v1" || !ok {
		t.Fatalf("committed value = %q,%v; want v1,true", v, ok)
	}
	if _, _, err := h.Get(); !errors.Is(err, ErrTxClosed) {
		t.Fatalf("Get after commit: err = %v; want ErrTxClosed", err)
	}
	if err := h.Set("x"); !errors.Is(err, ErrTxClosed) {
		t.Fatalf("Set after commit: err = %v; want ErrTxClosed", err)
	}
	if err := h.Delete(); !errors.Is(err, ErrTxClosed) {
		t.Fatalf("Delete after commit: err = %v; want ErrTxClosed", err)
	}
	// Double commit is rejected too.
	if err := tx.Commit(); !errors.Is(err, ErrTxClosed) {
		t.Fatalf("second Commit: err = %v; want ErrTxClosed", err)
	}
}

func TestRollbackRejectsHandles(t *testing.T) {
	c := New()
	tx := c.Begin()
	h := tx.Handle("k")
	if err := h.Set("v1"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Get("k"); ok {
		t.Fatal("rolled-back write leaked into committed state")
	}
	if _, _, err := h.Get(); !errors.Is(err, ErrTxClosed) {
		t.Fatalf("Get after rollback: err = %v; want ErrTxClosed", err)
	}
	if err := h.Set("x"); !errors.Is(err, ErrTxClosed) {
		t.Fatalf("Set after rollback: err = %v; want ErrTxClosed", err)
	}
}

func TestNestedSavepointRollback(t *testing.T) {
	c := New()
	tx := c.Begin()

	old := tx.Handle("k")
	if err := old.Set("base"); err != nil {
		t.Fatal(err)
	}

	sp1, err := tx.Savepoint()
	if err != nil {
		t.Fatal(err)
	}
	mid := tx.Handle("k")
	if err := mid.Set("mid"); err != nil {
		t.Fatal(err)
	}

	sp2, err := tx.Savepoint()
	if err != nil {
		t.Fatal(err)
	}
	fresh := tx.Handle("k")
	if err := fresh.Set("fresh"); err != nil {
		t.Fatal(err)
	}

	// Roll back the inner savepoint: only `fresh` dies, value returns to "mid".
	if err := tx.RollbackTo(sp2); err != nil {
		t.Fatal(err)
	}
	if _, _, err := fresh.Get(); !errors.Is(err, ErrHandleInvalid) {
		t.Fatalf("fresh handle after inner rollback: err = %v; want ErrHandleInvalid", err)
	}
	if v, ok := mustGet(t, mid); v != "mid" || !ok {
		t.Fatalf("mid handle sees %q,%v; want mid,true", v, ok)
	}
	if v, ok := mustGet(t, old); v != "mid" || !ok {
		t.Fatalf("old handle sees %q,%v; want mid,true", v, ok)
	}

	// Roll back the outer savepoint: `mid` dies too, `old` sees "base".
	if err := tx.RollbackTo(sp1); err != nil {
		t.Fatal(err)
	}
	if _, _, err := mid.Get(); !errors.Is(err, ErrHandleInvalid) {
		t.Fatalf("mid handle after outer rollback: err = %v; want ErrHandleInvalid", err)
	}
	if v, ok := mustGet(t, old); v != "base" || !ok {
		t.Fatalf("old handle sees %q,%v; want base,true", v, ok)
	}

	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if v, ok := c.Get("k"); v != "base" || !ok {
		t.Fatalf("committed = %q,%v; want base,true", v, ok)
	}
}

func TestSavepointRollbackRestoresDelete(t *testing.T) {
	c := New()
	tx0 := c.Begin()
	h0 := tx0.Handle("k")
	if err := h0.Set("committed"); err != nil {
		t.Fatal(err)
	}
	if err := tx0.Commit(); err != nil {
		t.Fatal(err)
	}

	tx := c.Begin()
	h := tx.Handle("k")
	sp, err := tx.Savepoint()
	if err != nil {
		t.Fatal(err)
	}
	if err := h.Delete(); err != nil {
		t.Fatal(err)
	}
	if _, ok := mustGet(t, h); ok {
		t.Fatal("expected key to be deleted in overlay")
	}
	if err := tx.RollbackTo(sp); err != nil {
		t.Fatal(err)
	}
	if v, ok := mustGet(t, h); v != "committed" || !ok {
		t.Fatalf("after rollback sees %q,%v; want committed,true", v, ok)
	}
}

func TestIDReuseCannotResurrectHandles(t *testing.T) {
	c := New()

	// Generation 1: mint handles with per-tx IDs 0,1,2.
	tx1 := c.Begin()
	old := make([]*Handle, 3)
	for i := range old {
		old[i] = tx1.Handle(fmt.Sprintf("k%d", i))
		if err := old[i].Set("gen1"); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx1.Commit(); err != nil {
		t.Fatal(err)
	}

	// Generation 2: handle IDs restart at 0, so the same numeric IDs
	// are reused. The old handles must stay dead regardless.
	tx2 := c.Begin()
	if tx2.ID() == tx1.ID() {
		t.Fatal("transaction generations must differ")
	}
	fresh := make([]*Handle, 3)
	for i := range fresh {
		fresh[i] = tx2.Handle(fmt.Sprintf("k%d", i))
		if fresh[i].id != old[i].id {
			t.Fatalf("expected ID reuse: fresh id %d, old id %d", fresh[i].id, old[i].id)
		}
	}
	for i := range old {
		if _, _, err := old[i].Get(); !errors.Is(err, ErrTxClosed) {
			t.Fatalf("old handle %d resurrected: err = %v", i, err)
		}
		if err := old[i].Set("zombie"); !errors.Is(err, ErrTxClosed) {
			t.Fatalf("old handle %d wrote after death: err = %v", i, err)
		}
		// The reused-ID handle of the new generation works fine.
		if v, ok := mustGet(t, fresh[i]); v != "gen1" || !ok {
			t.Fatalf("fresh handle %d sees %q,%v; want gen1,true", i, v, ok)
		}
	}
	if err := tx2.Rollback(); err != nil {
		t.Fatal(err)
	}
	// Now generation 2's handles are dead as well.
	for i := range fresh {
		if _, _, err := fresh[i].Get(); !errors.Is(err, ErrTxClosed) {
			t.Fatalf("gen2 handle %d survived rollback: err = %v", i, err)
		}
	}
}

func TestSavepointInvalidatedHandleIDsStayDeadWithinTx(t *testing.T) {
	c := New()
	tx := c.Begin()
	sp, err := tx.Savepoint()
	if err != nil {
		t.Fatal(err)
	}
	doomed := tx.Handle("k")
	if err := tx.RollbackTo(sp); err != nil {
		t.Fatal(err)
	}
	// New handles minted after the rollback get fresh IDs; the doomed
	// handle's ID is never reused inside this generation, and even a
	// forged lookalike must fail because the live-set entry is gone.
	if _, _, err := doomed.Get(); !errors.Is(err, ErrHandleInvalid) {
		t.Fatalf("doomed handle: err = %v; want ErrHandleInvalid", err)
	}
	forged := &Handle{tx: tx, txID: tx.id, id: doomed.id, key: "k"}
	if _, _, err := forged.Get(); !errors.Is(err, ErrHandleInvalid) {
		t.Fatalf("forged handle: err = %v; want ErrHandleInvalid", err)
	}
	later := tx.Handle("k")
	if later.id == doomed.id {
		t.Fatal("handle ID reused within one generation")
	}
	if err := later.Set("ok"); err != nil {
		t.Fatal(err)
	}
}
