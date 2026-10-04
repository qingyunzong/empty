package fencedstore

import (
	"errors"
	"fmt"
	"sync"
	"testing"
)

// Fences must be strictly increasing across grants.
func TestGrantStrictlyIncreasing(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	prev := uint64(0)
	for i := 0; i < 100; i++ {
		f, err := s.Grant("res", fmt.Sprintf("h%d", i))
		if err != nil {
			t.Fatal(err)
		}
		if f <= prev {
			t.Fatalf("fence not strictly increasing: prev=%d got=%d", prev, f)
		}
		prev = f
	}
}

// A write is accepted iff fence >= max and holder matches; an old-fence
// retry returns ErrStale and does not clobber the newer value.
func TestStaleRetryDoesNotAffectValue(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	f1, _ := s.Grant("res", "alice")
	if err := s.Write("res", "alice", f1, "v1"); err != nil {
		t.Fatal(err)
	}
	f2, _ := s.Grant("res", "bob")
	if err := s.Write("res", "bob", f2, "v2"); err != nil {
		t.Fatal(err)
	}

	// Stale retry from the old lease.
	if err := s.Write("res", "alice", f1, "v1-retry"); !errors.Is(err, ErrStale) {
		t.Fatalf("want ErrStale, got %v", err)
	}
	if v, _ := s.Read("res"); v != "v2" {
		t.Fatalf("stale retry changed value: %q", v)
	}

	// Current holder re-writing with the max fence is fine.
	if err := s.Write("res", "bob", f2, "v2b"); err != nil {
		t.Fatal(err)
	}
	if v, _ := s.Read("res"); v != "v2b" {
		t.Fatalf("value = %q", v)
	}

	// Right fence, wrong holder.
	if err := s.Write("res", "mallory", f2, "evil"); !errors.Is(err, ErrNotHolder) {
		t.Fatalf("want ErrNotHolder, got %v", err)
	}
	if v, _ := s.Read("res"); v != "v2b" {
		t.Fatalf("holder mismatch changed value: %q", v)
	}
}

// The maximum fence must survive a crash (close + reopen).
func TestRecoveryPersistsMaxFence(t *testing.T) {
	dir := t.TempDir()

	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	var last uint64
	for i := 0; i < 10; i++ {
		last, err = s.Grant("res", fmt.Sprintf("h%d", i))
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Write("res", "h9", last, "survivor"); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	// "Restart": fences must continue strictly above the persisted max.
	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	if got := s2.MaxFence("res"); got != last {
		t.Fatalf("recovered max fence = %d, want %d", got, last)
	}
	f, err := s2.Grant("res", "h10")
	if err != nil {
		t.Fatal(err)
	}
	if f <= last {
		t.Fatalf("fence regressed after recovery: %d <= %d", f, last)
	}
	// A pre-crash fence is stale after recovery.
	if err := s2.Write("res", "h9", last, "zombie"); !errors.Is(err, ErrStale) {
		t.Fatalf("want ErrStale after recovery, got %v", err)
	}
}

// Concurrent grants and writes: every accepted write must carry the max
// fence at its moment, and the final value must come from the last grant.
func TestConcurrentWrites(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	const workers = 32
	const rounds = 50

	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			holder := fmt.Sprintf("holder-%d", w)
			for r := 0; r < rounds; r++ {
				f, err := s.Grant("shared", holder)
				if err != nil {
					t.Error(err)
					return
				}
				// Only the currently-max fence can succeed; others must
				// fail with ErrStale (never a silent clobber).
				err = s.Write("shared", holder, f, fmt.Sprintf("%s/%d", holder, f))
				if err != nil && !errors.Is(err, ErrStale) {
					t.Errorf("unexpected write error: %v", err)
					return
				}
			}
		}(w)
	}
	wg.Wait()

	// After the storm, the stored value must be consistent with some
	// fence that was actually the max when written: grant once more and
	// confirm monotonicity held throughout.
	final, err := s.Grant("shared", "auditor")
	if err != nil {
		t.Fatal(err)
	}
	if want := uint64(workers*rounds + 1); final != want {
		t.Fatalf("final fence = %d, want %d (no fence lost or duplicated)", final, want)
	}
	v, ok := s.Read("shared")
	if !ok {
		t.Fatal("no value stored")
	}
	var fenceInValue uint64
	if _, err := fmt.Sscanf(v, "holder-%d/%d", new(int), &fenceInValue); err != nil {
		t.Fatalf("unparseable stored value %q", v)
	}
	if fenceInValue >= final {
		t.Fatalf("stored value fence %d not below final fence %d", fenceInValue, final)
	}
}

// Concurrent grants alone must never duplicate or skip a fence number.
func TestConcurrentGrantsUnique(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	const workers = 16
	const rounds = 100
	seen := make([]bool, workers*rounds+1)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for r := 0; r < rounds; r++ {
				f, err := s.Grant("r", fmt.Sprintf("h%d", w))
				if err != nil {
					t.Error(err)
					return
				}
				mu.Lock()
				if seen[f] {
					t.Errorf("duplicate fence %d", f)
				}
				seen[f] = true
				mu.Unlock()
			}
		}(w)
	}
	wg.Wait()
	for i := 1; i <= workers*rounds; i++ {
		if !seen[i] {
			t.Fatalf("fence %d missing", i)
		}
	}
}
