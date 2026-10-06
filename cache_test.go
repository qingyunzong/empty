package txcache

import (
	"errors"
	"testing"
)

func mustHandle(t *testing.T, tx *Txn, key string) *Handle {
	t.Helper()
	h, err := tx.Handle(key)
	if err != nil {
		t.Fatalf("Handle(%q): %v", key, err)
	}
	return h
}

func mustGet(t *testing.T, h *Handle) (string, bool) {
	t.Helper()
	v, ok, err := h.Get()
	if err != nil {
		t.Fatalf("Get(%q): %v", h.Key(), err)
	}
	return v, ok
}

func mustSavepoint(t *testing.T, tx *Txn) int {
	t.Helper()
	sp, err := tx.Savepoint()
	if err != nil {
		t.Fatalf("Savepoint: %v", err)
	}
	return sp
}

// Handles are bound to the transaction generation: after commit, every
// operation on every handle is rejected.
func TestCommitInvalidatesHandles(t *testing.T) {
	c := New()
	tx := c.Begin()
	h := mustHandle(t, tx, "a")
	if err := h.Set("1"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if _, _, err := h.Get(); !errors.Is(err, ErrInvalidHandle) {
		t.Fatalf("Get after commit: got %v, want ErrInvalidHandle", err)
	}
	if err := h.Set("2"); !errors.Is(err, ErrInvalidHandle) {
		t.Fatalf("Set after commit: got %v, want ErrInvalidHandle", err)
	}
	if err := h.Delete(); !errors.Is(err, ErrInvalidHandle) {
		t.Fatalf("Delete after commit: got %v, want ErrInvalidHandle", err)
	}
	// Committed data is visible to later readers.
	if v, ok := c.Get("a"); !ok || v != "1" {
		t.Fatalf("committed value: got %q,%v want 1,true", v, ok)
	}
}

// After rollback, handles are rejected and nothing is applied.
func TestRollbackInvalidatesHandles(t *testing.T) {
	c := New()
	tx := c.Begin()
	h := mustHandle(t, tx, "a")
	if err := h.Set("1"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	if _, _, err := h.Get(); !errors.Is(err, ErrInvalidHandle) {
		t.Fatalf("Get after rollback: got %v, want ErrInvalidHandle", err)
	}
	if err := h.Set("2"); !errors.Is(err, ErrInvalidHandle) {
		t.Fatalf("Set after rollback: got %v, want ErrInvalidHandle", err)
	}
	if _, ok := c.Get("a"); ok {
		t.Fatal("rolled-back write leaked into cache")
	}
}

// A handle from a finished generation stays invalid even after newer
// transactions begin (and even though handle IDs restart at 0).
func TestGenerationBindingAcrossTransactions(t *testing.T) {
	c := New()
	tx1 := c.Begin()
	old := mustHandle(t, tx1, "a")
	if err := tx1.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	tx2 := c.Begin()
	if tx2.Generation() == tx1.Generation() {
		t.Fatal("generations must be unique")
	}
	fresh := mustHandle(t, tx2, "a") // reuses handle ID 0 in a new generation
	if err := fresh.Set("new"); err != nil {
		t.Fatalf("Set on fresh handle: %v", err)
	}
	if _, _, err := old.Get(); !errors.Is(err, ErrInvalidHandle) {
		t.Fatalf("old handle after new txn: got %v, want ErrInvalidHandle", err)
	}
	if err := tx2.Rollback(); err != nil {
		t.Fatalf("Rollback: %v", err)
	}
}

// Nested savepoint rollback invalidates only handles created after the
// savepoint; older handles survive and observe restored values.
func TestNestedSavepointRollback(t *testing.T) {
	c := New()
	tx := c.Begin()

	before := mustHandle(t, tx, "k")
	if err := before.Set("orig"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	outer := mustSavepoint(t, tx)

	if err := before.Set("changed"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	inner := mustSavepoint(t, tx)
	afterInner := mustHandle(t, tx, "k2")
	if err := afterInner.Set("x"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	// Roll back the inner savepoint: only afterInner dies.
	if err := tx.RollbackTo(inner); err != nil {
		t.Fatalf("RollbackTo(inner): %v", err)
	}
	if _, _, err := afterInner.Get(); !errors.Is(err, ErrInvalidHandle) {
		t.Fatalf("inner handle after rollback: got %v, want ErrInvalidHandle", err)
	}
	if v, ok := mustGet(t, before); !ok || v != "changed" {
		t.Fatalf("before handle: got %q,%v want changed,true", v, ok)
	}

	// Roll back the outer savepoint: the old handle survives and sees the
	// value it had at the savepoint.
	if err := tx.RollbackTo(outer); err != nil {
		t.Fatalf("RollbackTo(outer): %v", err)
	}
	if v, ok := mustGet(t, before); !ok || v != "orig" {
		t.Fatalf("restored value: got %q,%v want orig,true", v, ok)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if v, ok := c.Get("k"); !ok || v != "orig" {
		t.Fatalf("committed value: got %q,%v want orig,true", v, ok)
	}
	if _, ok := c.Get("k2"); ok {
		t.Fatal("write from invalidated handle leaked into cache")
	}
}

// Savepoint rollback rewinds the handle ID counter, so IDs are reused. A
// stale handle whose ID was reused must stay invalid.
func TestIDReuseCannotResurrectHandle(t *testing.T) {
	c := New()
	tx := c.Begin()

	victim := mustHandle(t, tx, "a") // ID 0
	sp := mustSavepoint(t, tx)       // nextID snapshot = 1
	doomed := mustHandle(t, tx, "b") // ID 1, created after savepoint

	if err := tx.RollbackTo(sp); err != nil {
		t.Fatalf("RollbackTo: %v", err)
	}
	if _, _, err := doomed.Get(); !errors.Is(err, ErrInvalidHandle) {
		t.Fatalf("doomed handle: got %v, want ErrInvalidHandle", err)
	}

	// The next handle reuses ID 1.
	replacement := mustHandle(t, tx, "b")
	if err := replacement.Set("live"); err != nil {
		t.Fatalf("Set on replacement: %v", err)
	}

	// The stale handle with the same ID must not come back to life.
	if _, _, err := doomed.Get(); !errors.Is(err, ErrInvalidHandle) {
		t.Fatalf("resurrected handle Get: got %v, want ErrInvalidHandle", err)
	}
	if err := doomed.Set("zombie"); !errors.Is(err, ErrInvalidHandle) {
		t.Fatalf("resurrected handle Set: got %v, want ErrInvalidHandle", err)
	}
	if err := doomed.Delete(); !errors.Is(err, ErrInvalidHandle) {
		t.Fatalf("resurrected handle Delete: got %v, want ErrInvalidHandle", err)
	}

	// The pre-savepoint handle and the replacement both work.
	if err := victim.Set("ok"); err != nil {
		t.Fatalf("Set on surviving handle: %v", err)
	}
	if v, ok := mustGet(t, replacement); !ok || v != "live" {
		t.Fatalf("replacement: got %q,%v want live,true", v, ok)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if v, ok := c.Get("b"); !ok || v != "live" {
		t.Fatalf("committed b: got %q,%v want live,true", v, ok)
	}
}

// Closed transactions reject new handles, savepoints, and repeated close.
func TestClosedTransactionRejectsOps(t *testing.T) {
	c := New()
	tx := c.Begin()
	if err := tx.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if _, err := tx.Handle("a"); !errors.Is(err, ErrTxnClosed) {
		t.Fatalf("Handle on closed txn: got %v, want ErrTxnClosed", err)
	}
	if _, err := tx.Savepoint(); !errors.Is(err, ErrTxnClosed) {
		t.Fatalf("Savepoint on closed txn: got %v, want ErrTxnClosed", err)
	}
	if err := tx.RollbackTo(0); !errors.Is(err, ErrTxnClosed) {
		t.Fatalf("RollbackTo on closed txn: got %v, want ErrTxnClosed", err)
	}
	if err := tx.Commit(); !errors.Is(err, ErrTxnClosed) {
		t.Fatalf("double Commit: got %v, want ErrTxnClosed", err)
	}
	if err := tx.Rollback(); !errors.Is(err, ErrTxnClosed) {
		t.Fatalf("Rollback after Commit: got %v, want ErrTxnClosed", err)
	}
}

// Rolling back to an unknown savepoint fails without corrupting the txn.
func TestBadSavepoint(t *testing.T) {
	c := New()
	tx := c.Begin()
	h := mustHandle(t, tx, "a")
	if err := tx.RollbackTo(0); !errors.Is(err, ErrBadSavepoint) {
		t.Fatalf("RollbackTo(0) with no savepoints: got %v, want ErrBadSavepoint", err)
	}
	if err := h.Set("still alive"); err != nil {
		t.Fatalf("handle broken by bad rollback: %v", err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatalf("Rollback: %v", err)
	}
}

// Delete through a handle hides committed values; commit applies the delete.
func TestDeleteSemantics(t *testing.T) {
	c := New()
	tx := c.Begin()
	h := mustHandle(t, tx, "a")
	if err := h.Set("1"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	tx2 := c.Begin()
	h2 := mustHandle(t, tx2, "a")
	if v, ok := mustGet(t, h2); !ok || v != "1" {
		t.Fatalf("read-through: got %q,%v want 1,true", v, ok)
	}
	if err := h2.Delete(); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, ok := mustGet(t, h2); ok {
		t.Fatal("deleted key still visible in txn")
	}
	if _, ok := c.Get("a"); !ok {
		t.Fatal("uncommitted delete leaked into cache")
	}
	if err := tx2.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if _, ok := c.Get("a"); ok {
		t.Fatal("committed delete not applied")
	}
}
