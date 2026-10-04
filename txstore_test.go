package txstore

import (
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

// keyForPartition returns a key that hashes into the given partition.
func keyForPartition(nparts, target int) string {
	for i := 0; ; i++ {
		k := fmt.Sprintf("key-%d", i)
		if partOfKey(k, nparts) == target {
			return k
		}
	}
}

// runCatching runs fn, converting a simulated crash panic into crashed=true.
func runCatching(fn func() error) (err error, crashed bool) {
	defer func() {
		if r := recover(); r != nil {
			if _, ok := r.(crashSentinel); ok {
				crashed = true
				err = nil
				return
			}
			panic(r)
		}
	}()
	err = fn()
	return
}

// crashAt returns a hook that simulates power loss at the named event.
func crashAt(point string) func(string) {
	return func(event string) {
		if event == point {
			panic(crashSentinel{})
		}
	}
}

// durableDecision reads the decision log file directly from disk.
func durableDecision(t *testing.T, dir, txnID string) string {
	t.Helper()
	recs, err := readWAL(filepath.Join(dir, "decisions.log"))
	if err != nil {
		t.Fatalf("read decisions: %v", err)
	}
	for _, r := range recs {
		if r.Type == recDecision && r.TxnID == txnID {
			return r.Decision
		}
	}
	return ""
}

func TestCommitMakesAllWritesVisible(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	k0, k1, k2 := keyForPartition(3, 0), keyForPartition(3, 1), keyForPartition(3, 2)
	tx := Txn{ID: "tx1", Reads: []string{k0, k1, k2}, Writes: map[string]string{k0: "a", k1: "b", k2: "c"}}
	if err := s.Prepare(tx); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if err := s.Commit("tx1"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	for k, want := range map[string]string{k0: "a", k1: "b", k2: "c"} {
		got, err := s.Get(k)
		if err != nil || got != want {
			t.Fatalf("Get(%q) = %q, %v; want %q", k, got, err, want)
		}
	}
}

func TestPendingKeysRejectReads(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	k := keyForPartition(2, 0)
	tx := Txn{ID: "tx1", Writes: map[string]string{k: "v"}}
	if err := s.Prepare(tx); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if _, err := s.Get(k); !errors.Is(err, ErrPending) {
		t.Fatalf("Get on prepared key = %v; want ErrPending", err)
	}
	if err := s.Commit("tx1"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if got, err := s.Get(k); err != nil || got != "v" {
		t.Fatalf("Get after commit = %q, %v", got, err)
	}
}

func TestAbortLeavesNothingVisible(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	k := keyForPartition(2, 1)
	if err := s.Prepare(Txn{ID: "tx1", Writes: map[string]string{k: "v"}}); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if err := s.Abort("tx1"); err != nil {
		t.Fatalf("abort: %v", err)
	}
	if _, err := s.Get(k); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after abort = %v; want ErrNotFound", err)
	}
	// Locks are released: a later transaction can take the same key.
	if err := s.Prepare(Txn{ID: "tx2", Writes: map[string]string{k: "w"}}); err != nil {
		t.Fatalf("prepare after abort: %v", err)
	}
	if err := s.Commit("tx2"); err != nil {
		t.Fatalf("commit tx2: %v", err)
	}
	if got, _ := s.Get(k); got != "w" {
		t.Fatalf("Get = %q; want w", got)
	}
}

func TestConflictingPrepareRejected(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	k := keyForPartition(2, 0)
	if err := s.Prepare(Txn{ID: "tx1", Writes: map[string]string{k: "v"}}); err != nil {
		t.Fatalf("prepare tx1: %v", err)
	}
	if err := s.Prepare(Txn{ID: "tx2", Writes: map[string]string{k: "w"}}); !errors.Is(err, ErrLocked) {
		t.Fatalf("conflicting prepare = %v; want ErrLocked", err)
	}
	if err := s.Prepare(Txn{ID: "tx1", Writes: map[string]string{k: "v"}}); !errors.Is(err, ErrTxnExists) {
		t.Fatalf("duplicate prepare = %v; want ErrTxnExists", err)
	}
}

func TestUnknownTxnRejected(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Commit("nope"); !errors.Is(err, ErrUnknownTxn) {
		t.Fatalf("commit unknown = %v; want ErrUnknownTxn", err)
	}
	if err := s.Abort("nope"); !errors.Is(err, ErrUnknownTxn) {
		t.Fatalf("abort unknown = %v; want ErrUnknownTxn", err)
	}
}

// TestTimeoutIsNotAbort: a coordinator that goes silent after Prepare must
// not cause the transaction to be aborted. The key stays locked, reads keep
// being rejected, and a late Commit still succeeds — the transaction's fate
// is decided only by an explicit decision, never by a timeout.
func TestTimeoutIsNotAbort(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	k := keyForPartition(2, 0)
	if err := s.Prepare(Txn{ID: "tx1", Writes: map[string]string{k: "v"}}); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	// Simulate a coordinator that stops responding ("times out").
	time.Sleep(50 * time.Millisecond)
	if _, err := s.Get(k); !errors.Is(err, ErrPending) {
		t.Fatalf("Get during coordinator silence = %v; want ErrPending (no unilateral abort)", err)
	}
	if err := s.Commit("tx1"); err != nil {
		t.Fatalf("late commit must still succeed, got %v", err)
	}
	if got, err := s.Get(k); err != nil || got != "v" {
		t.Fatalf("Get after late commit = %q, %v", got, err)
	}
}

// TestRecoveryReplaysDurableCommit: crash after the decision is durable but
// before partitions finish applying — recovery must make every write visible.
func TestRecoveryReplaysDurableCommit(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	k0, k1, k2 := keyForPartition(3, 0), keyForPartition(3, 1), keyForPartition(3, 2)
	tx := Txn{ID: "tx1", Writes: map[string]string{k0: "a", k1: "b", k2: "c"}}
	s.hook = crashAt("apply-1")
	_, crashed := runCatching(func() error {
		if err := s.Prepare(tx); err != nil {
			return err
		}
		return s.Commit("tx1")
	})
	if !crashed {
		t.Fatal("expected simulated crash")
	}
	s2, err := Open(dir, 3)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	for k, want := range map[string]string{k0: "a", k1: "b", k2: "c"} {
		got, err := s2.Get(k)
		if err != nil || got != want {
			t.Fatalf("after recovery Get(%q) = %q, %v; want %q", k, got, err, want)
		}
	}
}

// TestRecoveryAbortsUndecided: crash before any decision exists — recovery
// aborts, nothing becomes visible, and the old committed value stays.
func TestRecoveryAbortsUndecided(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	k0, k1 := keyForPartition(3, 0), keyForPartition(3, 1)
	if err := s.Prepare(Txn{ID: "seed", Writes: map[string]string{k0: "old0", k1: "old1"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Commit("seed"); err != nil {
		t.Fatal(err)
	}
	s.hook = crashAt("prepare-1")
	_, crashed := runCatching(func() error {
		return s.Prepare(Txn{ID: "tx1", Writes: map[string]string{k0: "new0", k1: "new1"}})
	})
	if !crashed {
		t.Fatal("expected simulated crash")
	}
	s2, err := Open(dir, 3)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	for k, want := range map[string]string{k0: "old0", k1: "old1"} {
		got, err := s2.Get(k)
		if err != nil || got != want {
			t.Fatalf("after recovery Get(%q) = %q, %v; want %q", k, got, err, want)
		}
	}
	if dec := durableDecision(t, dir, "tx1"); dec != decideAbort {
		t.Fatalf("recovery decision = %q; want abort", dec)
	}
}
