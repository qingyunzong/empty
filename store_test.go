package ptxn

import (
	"errors"
	"fmt"
	"hash/fnv"
	"testing"
	"time"
)

const testPartitions = 3

// keysForPartitions returns one key per partition so tests can spread a
// transaction's write set across every partition.
func keysForPartitions(n int) []string {
	seen := make(map[int]string)
	keys := make([]string, 0, n)
	for i := 0; len(keys) < n; i++ {
		k := fmt.Sprintf("key-%d", i)
		h := fnv.New32a()
		h.Write([]byte(k))
		p := int(h.Sum32()) % n
		if _, ok := seen[p]; !ok {
			seen[p] = k
			keys = append(keys, k)
		}
	}
	return keys
}

func writeSet(keys []string, val string) map[string]string {
	w := make(map[string]string, len(keys))
	for _, k := range keys {
		w[k] = val
	}
	return w
}

func openTestStore(t *testing.T) (*Store, string, []string) {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(dir, testPartitions)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s, dir, keysForPartitions(testPartitions)
}

func mustGet(t *testing.T, s *Store, key string) (string, bool) {
	t.Helper()
	v, ok, err := s.Get(key)
	if err != nil {
		t.Fatalf("Get(%q): %v", key, err)
	}
	return v, ok
}

func TestPrepareCommitVisibleAcrossPartitions(t *testing.T) {
	s, _, keys := openTestStore(t)
	if err := s.Prepare("t1", []string{keys[0]}, writeSet(keys, "v1")); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if err := s.Commit("t1"); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	for _, k := range keys {
		if v, ok := mustGet(t, s, k); !ok || v != "v1" {
			t.Fatalf("key %q: got (%q,%v), want (v1,true)", k, v, ok)
		}
	}
}

func TestAbortNeverVisible(t *testing.T) {
	s, _, keys := openTestStore(t)
	if err := s.Prepare("t1", nil, writeSet(keys, "v1")); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if err := s.Abort("t1"); err != nil {
		t.Fatalf("Abort: %v", err)
	}
	for _, k := range keys {
		if _, ok := mustGet(t, s, k); ok {
			t.Fatalf("key %q visible after abort", k)
		}
	}
}

func TestPendingKeyRejectsReadBeforeAndAfterRecovery(t *testing.T) {
	s, dir, keys := openTestStore(t)
	if err := s.Prepare("t1", nil, writeSet(keys, "v1")); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	for _, k := range keys {
		if _, _, err := s.Get(k); !errors.Is(err, ErrPending) {
			t.Fatalf("Get(%q) before recovery: %v, want ErrPending", k, err)
		}
	}
	// Recover without any decision: keys must still reject reads.
	s2, err := Open(dir, testPartitions)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	for _, k := range keys {
		if _, _, err := s2.Get(k); !errors.Is(err, ErrPending) {
			t.Fatalf("Get(%q) after recovery: %v, want ErrPending", k, err)
		}
	}
	if st, err := s2.Status("t1"); err != nil || st != StatusPrepared {
		t.Fatalf("Status after recovery: %v, %v", st, err)
	}
	// An explicit decision after recovery resolves the pending state.
	if err := s2.Commit("t1"); err != nil {
		t.Fatalf("Commit after recovery: %v", err)
	}
	for _, k := range keys {
		if v, ok := mustGet(t, s2, k); !ok || v != "v1" {
			t.Fatalf("key %q after commit: got (%q,%v)", k, v, ok)
		}
	}
}

func TestTimeoutIsNotAbort(t *testing.T) {
	s, _, keys := openTestStore(t)
	if err := s.Prepare("t1", nil, writeSet(keys, "v1")); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	// Wait well beyond any reasonable "timeout". The library has no
	// timeout mechanism: the transaction must remain prepared, keys must
	// keep rejecting reads, and a later commit must still succeed.
	time.Sleep(150 * time.Millisecond)
	if st, err := s.Status("t1"); err != nil || st != StatusPrepared {
		t.Fatalf("Status after wait: %v, %v; want prepared (timeout must not abort)", st, err)
	}
	if _, _, err := s.Get(keys[0]); !errors.Is(err, ErrPending) {
		t.Fatalf("Get after wait: %v, want ErrPending", err)
	}
	if err := s.Commit("t1"); err != nil {
		t.Fatalf("Commit after wait: %v (timeout must not abort)", err)
	}
	if v, ok := mustGet(t, s, keys[0]); !ok || v != "v1" {
		t.Fatalf("after commit: got (%q,%v)", v, ok)
	}
}

func TestPrepareConflictOnLockedKey(t *testing.T) {
	s, _, keys := openTestStore(t)
	if err := s.Prepare("t1", nil, writeSet(keys, "v1")); err != nil {
		t.Fatalf("Prepare t1: %v", err)
	}
	if err := s.Prepare("t2", nil, map[string]string{keys[0]: "v2"}); !errors.Is(err, ErrKeyLocked) {
		t.Fatalf("Prepare t2: %v, want ErrKeyLocked", err)
	}
	if err := s.Abort("t1"); err != nil {
		t.Fatalf("Abort t1: %v", err)
	}
	if err := s.Prepare("t2", nil, map[string]string{keys[0]: "v2"}); err != nil {
		t.Fatalf("Prepare t2 after abort: %v", err)
	}
}

func TestDecisionErrors(t *testing.T) {
	s, _, keys := openTestStore(t)
	if err := s.Commit("nope"); !errors.Is(err, ErrTxnNotFound) {
		t.Fatalf("Commit unknown: %v", err)
	}
	if err := s.Abort("nope"); !errors.Is(err, ErrTxnNotFound) {
		t.Fatalf("Abort unknown: %v", err)
	}
	if err := s.Prepare("t1", nil, writeSet(keys, "v1")); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if err := s.Prepare("t1", nil, nil); !errors.Is(err, ErrTxnExists) {
		t.Fatalf("duplicate Prepare: %v", err)
	}
	if err := s.Commit("t1"); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if err := s.Commit("t1"); !errors.Is(err, ErrTxnNotPrepared) {
		t.Fatalf("double Commit: %v", err)
	}
	if err := s.Abort("t1"); !errors.Is(err, ErrTxnNotPrepared) {
		t.Fatalf("Abort after Commit: %v", err)
	}
}

// TestExhaustiveFaultInjection arms every crash point in turn, runs a
// cross-partition transaction into it, recovers, and verifies the
// all-or-nothing guarantee: either the transaction is fully committed on
// every partition or it is fully invisible (pending keys reject reads and
// can still be explicitly aborted or committed, never partially applied).
func TestExhaustiveFaultInjection(t *testing.T) {
	keys := keysForPartitions(testPartitions)
	points := []struct {
		name      string
		event     FaultEvent
		partition int
	}{
		{"beforePreparePersist", FaultBeforePreparePersist, -1},
		{"afterPreparePersist", FaultAfterPreparePersist, -1},
		{"beforeCommitPersist", FaultBeforeCommitPersist, -1},
		{"afterCommitPersist", FaultAfterCommitPersist, -1},
		{"commitApplyPartition0", FaultCommitApplyPartition, 0},
		{"commitApplyPartition1", FaultCommitApplyPartition, 1},
		{"commitApplyPartition2", FaultCommitApplyPartition, 2},
		{"beforeAbortPersist", FaultBeforeAbortPersist, -1},
		{"afterAbortPersist", FaultAfterAbortPersist, -1},
	}
	for _, p := range points {
		t.Run(p.name, func(t *testing.T) {
			dir := t.TempDir()
			s, err := Open(dir, testPartitions)
			if err != nil {
				t.Fatalf("Open: %v", err)
			}
			s.SetCrashPoint(p.event, p.partition)

			isAbortPoint := p.event == FaultBeforeAbortPersist || p.event == FaultAfterAbortPersist
			prepErr := s.Prepare("tx", nil, writeSet(keys, "new"))
			var decErr error
			if prepErr == nil {
				if isAbortPoint {
					decErr = s.Abort("tx")
				} else {
					decErr = s.Commit("tx")
				}
			}
			if !errors.Is(prepErr, ErrCrashed) && !errors.Is(decErr, ErrCrashed) {
				t.Fatalf("crash point %s never fired (prepare=%v, decision=%v)", p.name, prepErr, decErr)
			}
			if _, _, err := s.Get(keys[0]); !errors.Is(err, ErrCrashed) {
				t.Fatalf("crashed store served a read: %v", err)
			}

			// Recover and check atomic visibility.
			r, err := Open(dir, testPartitions)
			if err != nil {
				t.Fatalf("recover: %v", err)
			}
			visible, pending := 0, 0
			for _, k := range keys {
				v, ok, err := r.Get(k)
				switch {
				case errors.Is(err, ErrPending):
					pending++
				case err != nil:
					t.Fatalf("Get(%q): %v", k, err)
				case ok && v == "new":
					visible++
				case ok:
					t.Fatalf("key %q has unexpected value %q", k, v)
				}
			}
			switch {
			case visible == len(keys):
				// Fully committed: only valid if the commit decision was
				// persisted before the crash.
				if isAbortPoint || p.event == FaultBeforePreparePersist ||
					p.event == FaultAfterPreparePersist || p.event == FaultBeforeCommitPersist {
					t.Fatalf("transaction fully visible although commit was never persisted")
				}
				if st, _ := r.Status("tx"); st != StatusCommitted {
					t.Fatalf("status = %v, want committed", st)
				}
			case visible == 0:
				// Fully invisible. Pending keys (if any) reject reads; an
				// explicit abort must leave everything invisible.
				if pending > 0 && pending != len(keys) {
					t.Fatalf("partial pending state: %d/%d keys pending", pending, len(keys))
				}
				if pending == len(keys) {
					if err := r.Abort("tx"); err != nil {
						t.Fatalf("Abort pending txn after recovery: %v", err)
					}
				}
				for _, k := range keys {
					if _, ok := mustGet(t, r, k); ok {
						t.Fatalf("key %q visible after abort", k)
					}
				}
			default:
				t.Fatalf("PARTIAL VISIBILITY: %d/%d keys committed", visible, len(keys))
			}
		})
	}
}

// TestRecoveryReplaysMixedTransactions commits one transaction, aborts
// another, leaves a third pending, then "crashes" (reopens) and verifies
// each transaction's state survives recovery correctly.
func TestRecoveryReplaysMixedTransactions(t *testing.T) {
	s, dir, keys := openTestStore(t)
	if err := s.Prepare("committed", nil, map[string]string{keys[0]: "c"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Commit("committed"); err != nil {
		t.Fatal(err)
	}
	if err := s.Prepare("aborted", nil, map[string]string{keys[1]: "a"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Abort("aborted"); err != nil {
		t.Fatal(err)
	}
	if err := s.Prepare("pending", nil, map[string]string{keys[2]: "p"}); err != nil {
		t.Fatal(err)
	}

	r, err := Open(dir, testPartitions)
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	if v, ok := mustGet(t, r, keys[0]); !ok || v != "c" {
		t.Fatalf("committed key: got (%q,%v)", v, ok)
	}
	if _, ok := mustGet(t, r, keys[1]); ok {
		t.Fatalf("aborted key visible")
	}
	if _, _, err := r.Get(keys[2]); !errors.Is(err, ErrPending) {
		t.Fatalf("pending key: %v, want ErrPending", err)
	}
}
