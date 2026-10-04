package authlib

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func openTemp(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "auth.wal")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s, path
}

func reopen(t *testing.T, path string) *Store {
	t.Helper()
	s, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	return s
}

func mustState(t *testing.T, s *Store, token string) (remaining, effects int) {
	t.Helper()
	r, err := s.Remaining(token)
	if err != nil {
		t.Fatalf("Remaining: %v", err)
	}
	e, err := s.Effects(token)
	if err != nil {
		t.Fatalf("Effects: %v", err)
	}
	return r, e
}

// One token allows exactly k actions; the (k+1)-th is rejected.
func TestQuotaExhaustion(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()
	if err := s.Grant("tok", 3); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		applied, err := s.Commit("tok", fmt.Sprintf("r%d", i))
		if err != nil || !applied {
			t.Fatalf("commit %d: applied=%v err=%v", i, applied, err)
		}
	}
	if _, err := s.Commit("tok", "r3"); !errors.Is(err, ErrExhausted) {
		t.Fatalf("want ErrExhausted, got %v", err)
	}
	r, e := mustState(t, s, "tok")
	if r != 0 || e != 3 {
		t.Fatalf("remaining=%d effects=%d, want 0/3", r, e)
	}
}

// A duplicate request ID never deducts twice.
func TestDuplicateRequestID(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()
	s.Grant("tok", 5)
	for i := 0; i < 10; i++ {
		applied, err := s.Commit("tok", "same-id")
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 && !applied {
			t.Fatal("first commit must apply")
		}
		if i > 0 && applied {
			t.Fatal("duplicate commit must not apply")
		}
	}
	r, e := mustState(t, s, "tok")
	if r != 4 || e != 1 {
		t.Fatalf("remaining=%d effects=%d, want 4/1", r, e)
	}
}

// A failed commit deducts nothing.
func TestFailureDoesNotDeduct(t *testing.T) {
	s, path := openTemp(t)
	s.Grant("tok", 5)
	s.Commit("tok", "ok-1")
	s.SetFailpoint(FailBeforeWrite, 1)
	if _, err := s.Commit("tok", "boom"); !errors.Is(err, ErrCrashed) {
		t.Fatalf("want ErrCrashed, got %v", err)
	}
	// Store is dead after crash; recover from the log.
	s2 := reopen(t, path)
	defer s2.Close()
	r, e := mustState(t, s2, "tok")
	if r != 4 || e != 1 {
		t.Fatalf("after crash: remaining=%d effects=%d, want 4/1", r, e)
	}
}

// At every crash point, recovery must keep remaining and effects
// consistent: a deduction exists iff its effect commit exists, because
// both live in the same log record.
func TestCrashPointsConsistency(t *testing.T) {
	stages := []string{FailBeforeWrite, FailDuringWrite, FailAfterWrite, FailAfterSync}
	for _, stage := range stages {
		t.Run(stage, func(t *testing.T) {
			s, path := openTemp(t)
			s.Grant("tok", 5)
			s.Commit("tok", "a")
			s.Commit("tok", "b")
			s.SetFailpoint(stage, 1)
			_, err := s.Commit("tok", "c")
			if !errors.Is(err, ErrCrashed) {
				t.Fatalf("want ErrCrashed, got %v", err)
			}
			s2 := reopen(t, path)
			defer s2.Close()
			r, e := mustState(t, s2, "tok")
			if r+e != 5 {
				t.Fatalf("invariant broken: remaining=%d effects=%d", r, e)
			}
			if e != 2 && e != 3 {
				t.Fatalf("effects=%d, want 2 or 3", e)
			}
			// Retrying the crashed request is idempotent either way:
			// it commits iff the crashed record did not survive.
			applied, err := s2.Commit("tok", "c")
			if err != nil {
				t.Fatal(err)
			}
			r2, e2 := mustState(t, s2, "tok")
			if e2 != 3 || r2 != 2 {
				t.Fatalf("after retry: remaining=%d effects=%d, want 2/3", r2, e2)
			}
			if e == 3 && applied {
				t.Fatal("retry of a survived commit must be a no-op")
			}
			if e == 2 && !applied {
				t.Fatal("retry of a lost commit must apply")
			}
		})
	}
}

// A commit that returned success is durable across crash + recovery.
func TestCommittedSurvivesReopen(t *testing.T) {
	s, path := openTemp(t)
	s.Grant("tok", 2)
	if _, err := s.Commit("tok", "x"); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s2 := reopen(t, path)
	defer s2.Close()
	r, e := mustState(t, s2, "tok")
	if r != 1 || e != 1 {
		t.Fatalf("remaining=%d effects=%d, want 1/1", r, e)
	}
	// Duplicate after recovery still does not deduct.
	if applied, _ := s2.Commit("tok", "x"); applied {
		t.Fatal("duplicate after recovery must not apply")
	}
}

// Revoke and commit are ordered by in-lock sequence: whichever acquires
// the mutex first determines the outcome, and the outcome is consistent.
func TestRevokeCommitOrdering(t *testing.T) {
	// Commit before revoke: effect counts, later commits rejected.
	s, _ := openTemp(t)
	s.Grant("tok", 5)
	s.Commit("tok", "first")
	if err := s.Revoke("tok"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Commit("tok", "second"); !errors.Is(err, ErrRevoked) {
		t.Fatalf("want ErrRevoked, got %v", err)
	}
	r, e := mustState(t, s, "tok")
	if r != 4 || e != 1 {
		t.Fatalf("remaining=%d effects=%d, want 4/1", r, e)
	}
	s.Close()

	// Revoke before commit: commit rejected, nothing deducted.
	s2, _ := openTemp(t)
	defer s2.Close()
	s2.Grant("tok", 5)
	s2.Revoke("tok")
	if _, err := s2.Commit("tok", "late"); !errors.Is(err, ErrRevoked) {
		t.Fatalf("want ErrRevoked, got %v", err)
	}
	r, e = mustState(t, s2, "tok")
	if r != 5 || e != 0 {
		t.Fatalf("remaining=%d effects=%d, want 5/0", r, e)
	}
}

// Concurrent revoke vs commit: the result must match some lock order,
// and recovered state must match the in-memory outcome.
func TestConcurrentRevokeCommit(t *testing.T) {
	for i := 0; i < 200; i++ {
		s, path := openTemp(t)
		s.Grant("tok", 10)
		var wg sync.WaitGroup
		var applied bool
		var commitErr error
		wg.Add(2)
		go func() {
			defer wg.Done()
			applied, commitErr = s.Commit("tok", "req")
		}()
		go func() {
			defer wg.Done()
			s.Revoke("tok")
		}()
		wg.Wait()

		r, e := mustState(t, s, "tok")
		switch {
		case applied:
			// Commit won the lock: deducted exactly once.
			if e != 1 || r != 9 {
				t.Fatalf("iter %d: commit won but remaining=%d effects=%d", i, r, e)
			}
		case errors.Is(commitErr, ErrRevoked):
			// Revoke won the lock: nothing deducted.
			if e != 0 || r != 10 {
				t.Fatalf("iter %d: revoke won but remaining=%d effects=%d", i, r, e)
			}
		default:
			t.Fatalf("iter %d: unexpected outcome applied=%v err=%v", i, applied, commitErr)
		}
		rev, _ := s.Revoked("tok")
		if !rev {
			t.Fatalf("iter %d: token must end revoked", i)
		}
		s.Close()

		// Recovery preserves the lock-order outcome.
		s2 := reopen(t, path)
		r2, e2 := mustState(t, s2, "tok")
		if r2 != r || e2 != e {
			t.Fatalf("iter %d: recovered %d/%d != in-memory %d/%d", i, r2, e2, r, e)
		}
		s2.Close()
	}
}

// Many goroutines racing with the same request ID deduct exactly once.
func TestConcurrentDuplicateRequests(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()
	s.Grant("tok", 100)
	const n = 64
	var wg sync.WaitGroup
	var mu sync.Mutex
	appliedCount := 0
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			applied, err := s.Commit("tok", "shared-req")
			if err != nil {
				t.Error(err)
				return
			}
			if applied {
				mu.Lock()
				appliedCount++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if appliedCount != 1 {
		t.Fatalf("applied %d times, want exactly 1", appliedCount)
	}
	r, e := mustState(t, s, "tok")
	if r != 99 || e != 1 {
		t.Fatalf("remaining=%d effects=%d, want 99/1", r, e)
	}
}

// More concurrent distinct requests than quota: exactly k succeed, the
// rest get ErrExhausted, and the result survives recovery.
func TestConcurrentDistinctRequests(t *testing.T) {
	s, path := openTemp(t)
	s.Grant("tok", 50)
	const n = 200
	var wg sync.WaitGroup
	var mu sync.Mutex
	appliedCount, exhausted := 0, 0
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			applied, err := s.Commit("tok", fmt.Sprintf("req-%d", i))
			mu.Lock()
			defer mu.Unlock()
			switch {
			case applied:
				appliedCount++
			case errors.Is(err, ErrExhausted):
				exhausted++
			default:
				t.Errorf("unexpected: applied=%v err=%v", applied, err)
			}
		}(i)
	}
	wg.Wait()
	if appliedCount != 50 || exhausted != 150 {
		t.Fatalf("applied=%d exhausted=%d, want 50/150", appliedCount, exhausted)
	}
	r, e := mustState(t, s, "tok")
	if r != 0 || e != 50 {
		t.Fatalf("remaining=%d effects=%d, want 0/50", r, e)
	}
	s.Close()
	s2 := reopen(t, path)
	defer s2.Close()
	r, e = mustState(t, s2, "tok")
	if r != 0 || e != 50 {
		t.Fatalf("recovered remaining=%d effects=%d, want 0/50", r, e)
	}
}

// A torn tail (partial record from a crash mid-write) is truncated on
// recovery; earlier records stay intact and the log keeps working.
func TestTornTailRecovery(t *testing.T) {
	s, path := openTemp(t)
	s.Grant("tok", 4)
	s.Commit("tok", "good")
	s.Close()

	// Simulate a crash that left half a record in the file.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	full := encodeRecord(recCommit, putString(putString(nil, "tok"), "lost"))
	f.Write(full[:len(full)/2])
	f.Close()

	s2 := reopen(t, path)
	defer s2.Close()
	r, e := mustState(t, s2, "tok")
	if r != 3 || e != 1 {
		t.Fatalf("remaining=%d effects=%d, want 3/1", r, e)
	}
	// Log is still appendable after truncation.
	if applied, err := s2.Commit("tok", "after"); err != nil || !applied {
		t.Fatalf("commit after recovery: applied=%v err=%v", applied, err)
	}
	s2.Close()
	s3 := reopen(t, path)
	defer s3.Close()
	r, e = mustState(t, s3, "tok")
	if r != 2 || e != 2 {
		t.Fatalf("remaining=%d effects=%d, want 2/2", r, e)
	}
}
