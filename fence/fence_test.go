package fence

import (
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
)

func openTemp(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "fence.state"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

func TestGrantStrictlyIncreasing(t *testing.T) {
	s := openTemp(t)
	prev := uint64(0)
	for i := 0; i < 100; i++ {
		tok, err := s.Grant("k", fmt.Sprintf("h%d", i))
		if err != nil {
			t.Fatalf("Grant: %v", err)
		}
		if tok <= prev {
			t.Fatalf("token %d not strictly greater than previous %d", tok, prev)
		}
		prev = tok
	}
	if got := s.MaxFence(); got != prev {
		t.Fatalf("MaxFence = %d, want %d", got, prev)
	}
}

func TestWriteAcceptedForCurrentHolder(t *testing.T) {
	s := openTemp(t)
	tok, err := s.Grant("k", "alice")
	if err != nil {
		t.Fatalf("Grant: %v", err)
	}
	if err := s.Write("k", "alice", tok, "v1"); err != nil {
		t.Fatalf("Write by current holder: %v", err)
	}
	val, fence, holder, granted := s.Read("k")
	if !granted || val != "v1" || fence != tok || holder != "alice" {
		t.Fatalf("Read = (%q,%d,%q,%v), want (v1,%d,alice,true)", val, fence, holder, granted, tok)
	}
}

func TestWriteRejectedForWrongHolder(t *testing.T) {
	s := openTemp(t)
	tok, _ := s.Grant("k", "alice")
	if err := s.Write("k", "mallory", tok, "evil"); !errors.Is(err, ErrNotHolder) {
		t.Fatalf("Write by wrong holder = %v, want ErrNotHolder", err)
	}
	if err := s.Write("never-granted", "alice", tok, "x"); !errors.Is(err, ErrNotHolder) {
		t.Fatalf("Write to ungranted key = %v, want ErrNotHolder", err)
	}
}

func TestStaleRetryDoesNotClobber(t *testing.T) {
	s := openTemp(t)
	oldTok, _ := s.Grant("k", "alice")
	newTok, _ := s.Grant("k", "bob")
	if err := s.Write("k", "bob", newTok, "new"); err != nil {
		t.Fatalf("Write by new holder: %v", err)
	}
	// Alice retries with her old token: must be reported stale and must
	// not overwrite the newer value.
	if err := s.Write("k", "alice", oldTok, "old"); !errors.Is(err, ErrStale) {
		t.Fatalf("stale retry = %v, want ErrStale", err)
	}
	val, fence, _, _ := s.Read("k")
	if val != "new" || fence != newTok {
		t.Fatalf("after stale retry Read = (%q,%d), want (new,%d)", val, fence, newTok)
	}
}

func TestRecoveryPersistsMaxFence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fence.state")
	s1, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	var last uint64
	for i := 0; i < 5; i++ {
		last, err = s1.Grant("k", "alice")
		if err != nil {
			t.Fatalf("Grant: %v", err)
		}
	}

	// Simulate crash + recovery: reopen from the same state file.
	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if got := s2.MaxFence(); got != last {
		t.Fatalf("recovered MaxFence = %d, want %d", got, last)
	}
	tok, err := s2.Grant("k", "carol")
	if err != nil {
		t.Fatalf("Grant after recovery: %v", err)
	}
	if tok <= last {
		t.Fatalf("token after recovery %d not greater than persisted max %d", tok, last)
	}
}

// TestConcurrentWrites enumerates many goroutines racing to write the
// same key after all grants are handed out, then verifies that exactly
// the write carrying the highest fence number survived and every losing
// write was reported stale rather than silently clobbering the winner.
func TestConcurrentWrites(t *testing.T) {
	s := openTemp(t)
	const writers = 64

	// Phase 1: grant all tokens concurrently.
	tokens := make([]uint64, writers)
	grantErrs := make([]error, writers)
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			tokens[i], grantErrs[i] = s.Grant("k", fmt.Sprintf("h%d", i))
		}(i)
	}
	wg.Wait()

	// Every granted token must be unique.
	seen := make(map[uint64]bool, writers)
	maxTok := uint64(0)
	for i, tok := range tokens {
		if tok == 0 {
			t.Fatalf("writer %d failed to grant: %v", i, grantErrs[i])
		}
		if seen[tok] {
			t.Fatalf("duplicate token %d", tok)
		}
		seen[tok] = true
		if tok > maxTok {
			maxTok = tok
		}
	}

	// Phase 2: all holders race to write with their token.
	errs := make([]error, writers)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = s.Write("k", fmt.Sprintf("h%d", i), tokens[i], fmt.Sprintf("v%d", tokens[i]))
		}(i)
	}
	wg.Wait()

	// Exactly one write (the max-token one) may have succeeded; every
	// other write must have failed with ErrStale.
	succeeded := 0
	for i, err := range errs {
		switch {
		case err == nil:
			succeeded++
			if tokens[i] != maxTok {
				t.Fatalf("writer %d with non-max token %d succeeded", i, tokens[i])
			}
		case errors.Is(err, ErrStale):
			if tokens[i] == maxTok {
				t.Fatalf("max-token writer %d reported stale", i)
			}
		default:
			t.Fatalf("writer %d unexpected error: %v", i, err)
		}
	}
	if succeeded != 1 {
		t.Fatalf("succeeded writes = %d, want 1", succeeded)
	}

	// Final state must be the winning write.
	val, fence, holder, granted := s.Read("k")
	want := fmt.Sprintf("v%d", maxTok)
	if !granted || val != want || fence != maxTok {
		t.Fatalf("final Read = (%q,%d,%q,%v), want (%q,%d,_,true)", val, fence, holder, granted, want, maxTok)
	}
}

// TestConcurrentStaleRetryAfterRace hammers the store with stale retries
// after a concurrent grant/write race, verifying the winning value is
// never disturbed.
func TestConcurrentStaleRetryAfterRace(t *testing.T) {
	s := openTemp(t)
	const writers = 32
	stale := make([]uint64, 0, writers-1)
	var mu sync.Mutex
	var maxTok uint64
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			holder := fmt.Sprintf("h%d", i)
			tok, _ := s.Grant("k", holder)
			if err := s.Write("k", holder, tok, fmt.Sprintf("v%d", tok)); err == nil {
				mu.Lock()
				maxTok = tok
				mu.Unlock()
			} else {
				mu.Lock()
				stale = append(stale, tok)
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()

	// Now retry all the stale tokens concurrently; all must fail with
	// ErrStale and the winning value must remain.
	var wg2 sync.WaitGroup
	for _, tok := range stale {
		wg2.Add(1)
		go func(tok uint64) {
			defer wg2.Done()
			if err := s.Write("k", "retry", tok, "clobber"); !errors.Is(err, ErrStale) {
				t.Errorf("stale retry with token %d = %v, want ErrStale", tok, err)
			}
		}(tok)
	}
	wg2.Wait()

	val, fence, _, _ := s.Read("k")
	if want := fmt.Sprintf("v%d", maxTok); val != want || fence != maxTok {
		t.Fatalf("final Read = (%q,%d), want (%q,%d)", val, fence, want, maxTok)
	}
}
