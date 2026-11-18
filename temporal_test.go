package formal

import (
	"errors"
	"math"
	"sync"
	"testing"
)

func mustLookup[V comparable](t *testing.T, s *LookupStore[V], key, at int64) (V, bool) {
	t.Helper()
	value, found, err := s.Lookup(key, at)
	if err != nil {
		t.Fatalf("Lookup(%d,%d) unexpected error: %v", key, at, err)
	}
	return value, found
}

// TestLookupHalfOpenBoundaries pins down the [ValidFrom, ValidTo) semantics:
// the start point is included, the end point is excluded.
func TestLookupHalfOpenBoundaries(t *testing.T) {
	s := NewLookupStore[int](0)
	if err := s.Upsert(1, 10, 20, 100); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		at    int64
		found bool
		value int
	}{
		{9, false, 0},
		{10, true, 100}, // ValidFrom inclusive
		{15, true, 100},
		{19, true, 100},
		{20, false, 0}, // ValidTo exclusive
	}
	for _, tc := range cases {
		value, found := mustLookup(t, s, 1, tc.at)
		if found != tc.found || (found && value != tc.value) {
			t.Errorf("Lookup at %d = (%d,%v), want (%d,%v)", tc.at, value, found, tc.value, tc.found)
		}
	}
}

// TestLookupVersionChain checks that adjacent versions partition time without
// gaps or overlaps and that the newest open-ended version never expires.
func TestLookupVersionChain(t *testing.T) {
	s := NewLookupStore[string](0)
	if err := s.Upsert(7, 0, 0, "a"); err != nil {
		t.Fatal(err)
	}
	if err := s.Upsert(7, 5, 0, "b"); err != nil {
		t.Fatal(err)
	}
	if err := s.Upsert(7, 9, 0, "c"); err != nil {
		t.Fatal(err)
	}

	cases := map[int64]string{
		0: "a", 4: "a",
		5: "b", 8: "b",
		9: "c", 1_000_000: "c",
	}
	for at, want := range cases {
		value, found := mustLookup(t, s, 7, at)
		if !found || value != want {
			t.Errorf("Lookup at %d = (%q,%v), want %q", at, value, found, want)
		}
	}

	versions := s.debugVersions(7)
	if len(versions) != 3 {
		t.Fatalf("got %d versions, want 3", len(versions))
	}
	wantIntervals := []struct{ from, to int64 }{
		{0, 5}, {5, 9}, {9, math.MaxInt64},
	}
	for i, want := range wantIntervals {
		if versions[i].ValidFrom != want.from || versions[i].ValidTo != want.to {
			t.Errorf("version %d interval = [%d,%d), want [%d,%d)",
				i, versions[i].ValidFrom, versions[i].ValidTo, want.from, want.to)
		}
	}
}

// TestFutureVersionNotSelected interleaves a watermark and a not-yet-effective
// version: probes before ValidFrom must keep selecting the old version.
func TestFutureVersionNotSelected(t *testing.T) {
	s := NewLookupStore[int](2)
	if err := s.Upsert(3, 0, 0, 11); err != nil {
		t.Fatal(err)
	}
	if err := s.Advance(8); err != nil {
		t.Fatal(err)
	}
	// Version starts in the future relative to the probe event time.
	if err := s.Upsert(3, 12, 0, 22); err != nil {
		t.Fatal(err)
	}

	for _, at := range []int64{6, 7, 8, 9, 10, 11} {
		value, found := mustLookup(t, s, 3, at)
		if !found || value != 11 {
			t.Errorf("Lookup at %d selected (%d,%v), want old version 11", at, value, found)
		}
	}
	value, found := mustLookup(t, s, 3, 12)
	if !found || value != 22 {
		t.Errorf("Lookup at 12 = (%d,%v), want new version 22", value, found)
	}

	em, ok, err := s.Probe(1, 9, 3)
	if err != nil || !ok || em.Deleted || em.Value != 11 {
		t.Fatalf("probe before effective time = %+v ok=%v err=%v", em, ok, err)
	}
}

// TestWatermarkLatenessBoundary exercises the inclusive horizon: a probe at
// exactly watermark-lateness is accepted; one tick older is dropped.
func TestWatermarkLatenessBoundary(t *testing.T) {
	s := NewLookupStore[int](3)
	if err := s.Upsert(1, 0, 0, 7); err != nil {
		t.Fatal(err)
	}
	if err := s.Advance(10); err != nil {
		t.Fatal(err)
	}

	// horizon = 10 - 3 = 7.
	if _, ok, err := s.Probe(100, 7, 1); err != nil || !ok {
		t.Errorf("probe at horizon 7 should be accepted: ok=%v err=%v", ok, err)
	}
	if _, ok, err := s.Probe(101, 6, 1); err != nil || ok {
		t.Errorf("probe at 6 should be dropped: ok=%v err=%v", ok, err)
	}

	// A write starting exactly at the horizon is still on time.
	if err := s.Upsert(1, 7, 0, 8); err != nil {
		t.Errorf("upsert at horizon should be accepted: %v", err)
	}
	// A write one tick older is rejected and leaves state untouched.
	if err := s.Upsert(1, 6, 0, 9); !errors.Is(err, ErrInvalidTime) {
		t.Errorf("upsert before horizon should fail with ErrInvalidTime, got %v", err)
	}
	if value, found := mustLookup(t, s, 1, 7); !found || value != 8 {
		t.Errorf("rejected late write changed state: got (%d,%v)", value, found)
	}
}

// TestLateWriteRevisesWithinWindow appends a late-but-allowed version after
// the probe: the original output stays in the journal and a correction is
// appended rather than rewriting history.
func TestLateWriteRevisesWithinWindow(t *testing.T) {
	s := NewLookupStore[int](5)
	if err := s.Upsert(1, 0, 0, 1); err != nil {
		t.Fatal(err)
	}
	if err := s.Advance(10); err != nil {
		t.Fatal(err) // horizon = 5
	}

	first, ok, err := s.Probe(50, 6, 1)
	if err != nil || !ok || first.Value != 1 || first.Seq != 0 {
		t.Fatalf("initial probe = %+v ok=%v err=%v", first, ok, err)
	}
	if drained := s.Sweep(); len(drained) != 1 || drained[0].Value != 1 {
		t.Fatalf("initial emission not drained as expected: %+v", drained)
	}

	// Late write revises the value at time 6 (5 <= 6, inside the window).
	if err := s.Upsert(1, 5, 0, 2); err != nil {
		t.Fatal(err)
	}
	corrections := s.Sweep()
	if len(corrections) != 1 {
		t.Fatalf("got %d corrections, want 1", len(corrections))
	}
	rev := corrections[0]
	if rev.EventID != 50 || rev.Value != 2 || rev.Deleted || rev.Seq != 1 {
		t.Fatalf("unexpected correction: %+v", rev)
	}

	journal := s.Journal()
	if len(journal) != 2 || journal[0].Value != 1 || journal[1].Value != 2 {
		t.Fatalf("historical output was rewritten: %+v", journal)
	}

	// Replaying the same event returns the current emission without a dup.
	replay, ok, err := s.Probe(50, 6, 1)
	if err != nil || !ok || replay.Seq != 1 || replay.Value != 2 {
		t.Fatalf("replay probe = %+v ok=%v err=%v", replay, ok, err)
	}
	if len(s.Journal()) != 2 {
		t.Fatalf("replay appended a duplicate emission")
	}
}

// TestTombstoneRetraction verifies that a delete emits a Deleted correction
// and that lookups inside the tombstone interval report the key absent.
func TestTombstoneRetraction(t *testing.T) {
	s := NewLookupStore[int](10)
	if err := s.Upsert(1, 0, 0, 9); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.Probe(7, 4, 1); err != nil || !ok {
		t.Fatalf("initial probe failed: ok=%v err=%v", ok, err)
	}
	if drained := s.Sweep(); len(drained) != 1 || drained[0].Deleted {
		t.Fatalf("initial emission not drained as expected: %+v", drained)
	}

	if err := s.Delete(1, 4, 0); err != nil {
		t.Fatal(err)
	}
	corrections := s.Sweep()
	if len(corrections) != 1 || !corrections[0].Deleted || corrections[0].EventID != 7 {
		t.Fatalf("want one deletion correction, got %+v", corrections)
	}
	if _, found := mustLookup(t, s, 1, 4); found {
		t.Error("lookup inside tombstone interval must report absent")
	}
	if value, found := mustLookup(t, s, 1, 3); !found || value != 9 {
		t.Errorf("pre-tombstone history changed: (%d,%v)", value, found)
	}

	// A new version after the tombstone makes the key visible again.
	if err := s.Upsert(1, 8, 0, 10); err != nil {
		t.Fatal(err)
	}
	if value, found := mustLookup(t, s, 1, 8); !found || value != 10 {
		t.Errorf("key did not return after tombstone: (%d,%v)", value, found)
	}
}

// TestAdvanceGarbageCollectsHistory ensures expired versions and tracked
// probes are reclaimed once no accepted event can observe them.
func TestAdvanceGarbageCollectsHistory(t *testing.T) {
	s := NewLookupStore[int](2)
	if err := s.Upsert(1, 0, 0, 1); err != nil {
		t.Fatal(err)
	}
	if err := s.Upsert(1, 5, 0, 2); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.Probe(1, 1, 1); err != nil || !ok {
		t.Fatal(err)
	}
	if drained := s.Sweep(); len(drained) != 1 {
		t.Fatalf("initial emission missing: %+v", drained)
	}

	if err := s.Advance(10); err != nil { // horizon = 8
		t.Fatal(err)
	}
	versions := s.debugVersions(1)
	for _, v := range versions {
		if v.ValidTo <= 8 {
			t.Errorf("expired version retained after advance: %+v", v)
		}
	}
	// Probe t=1 is older than the horizon (8), so it can never be revised
	// further and is reclaimed from the revision-tracking index.
	if s.debugTracked(1) != 0 {
		t.Errorf("probe below horizon should be reclaimed, got %d tracked", s.debugTracked(1))
	}

	// The surviving interval still serves probes inside its range.
	if value, found := mustLookup(t, s, 1, 8); !found || value != 2 {
		t.Errorf("lookup after GC = (%d,%v), want 2", value, found)
	}
	// A late write inside the window still revises a surviving tracked probe.
	s2 := NewLookupStore[int](5)
	if err := s2.Upsert(9, 0, 0, 1); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s2.Probe(2, 6, 9); err != nil || !ok {
		t.Fatal(err)
	}
	s2.Sweep()
	if err := s2.Advance(10); err != nil { // horizon 5; probe t=6 stays tracked
		t.Fatal(err)
	}
	if s2.debugTracked(9) != 1 {
		t.Fatalf("in-window probe must remain revisable, got %d", s2.debugTracked(9))
	}
	if err := s2.Upsert(9, 6, 0, 2); err != nil {
		t.Fatal(err)
	}
	if corr := s2.Sweep(); len(corr) != 1 || corr[0].Value != 2 || corr[0].Seq != 1 {
		t.Fatalf("late revision after advance failed: %+v", corr)
	}

	if err := s.Advance(math.MaxInt64); err != nil {
		t.Fatal(err)
	}
	// At a maximal horizon only the open-ended current version survives;
	// every finite interval has been garbage collected.
	for _, v := range s.debugVersions(1) {
		if v.ValidTo != math.MaxInt64 {
			t.Errorf("finite version survived maximal watermark: %+v", v)
		}
	}
	// All finite timestamps are now beyond acceptance.
	if _, ok, err := s.Probe(99, 100, 1); err != nil || ok {
		t.Errorf("probe under maximal watermark must be dropped: ok=%v err=%v", ok, err)
	}
}

// TestInvalidInputs guards the time and interval validation.
func TestInvalidInputs(t *testing.T) {
	s := NewLookupStore[int](0)
	if _, _, err := s.Lookup(1, -1); !errors.Is(err, ErrInvalidTime) {
		t.Errorf("negative lookup time: got %v", err)
	}
	if _, ok, err := s.Probe(1, -1, 1); !errors.Is(err, ErrInvalidTime) || ok {
		t.Errorf("negative probe time: ok=%v err=%v", ok, err)
	}
	if err := s.Advance(-1); !errors.Is(err, ErrInvalidTime) {
		t.Errorf("negative watermark: got %v", err)
	}
	if err := s.Upsert(1, 5, 5, 1); !errors.Is(err, ErrInvalidTime) {
		t.Errorf("empty interval: got %v", err)
	}
	if err := s.Upsert(1, 5, 4, 1); !errors.Is(err, ErrInvalidTime) {
		t.Errorf("inverted interval: got %v", err)
	}
	if err := s.Upsert(1, -1, 0, 1); !errors.Is(err, ErrInvalidTime) {
		t.Errorf("negative validFrom: got %v", err)
	}
}

// TestConcurrentAccess exercises the RWMutex-protected surface under the race
// detector with mixed readers, writers, probes and watermark advances.
func TestConcurrentAccess(t *testing.T) {
	s := NewLookupStore[int](5)
	var wg sync.WaitGroup

	for worker := 0; worker < 4; worker++ {
		wg.Add(1)
		go func(base int64) {
			defer wg.Done()
			for i := int64(0); i < 100; i++ {
				key := (base + i) % 4
				_ = s.Upsert(key, i, 0, int(i))
				_, _, _ = s.Lookup(key, i)
				_, _, _ = s.Probe(base*1000+i, i, key)
				_ = s.Advance(i)
				_ = s.Sweep()
			}
		}(int64(worker * 100))
	}

	wg.Wait()
	if len(s.Journal()) == 0 {
		t.Error("expected concurrent probes to emit outputs")
	}
}
