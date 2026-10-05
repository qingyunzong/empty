package logcompact

import (
	"sync"
	"testing"
)

func TestAppendAndReadFrom(t *testing.T) {
	l := New()
	for i := 0; i < 5; i++ {
		if off := l.Append("k", []byte{byte(i)}); off != uint64(i) {
			t.Fatalf("append %d got offset %d", i, off)
		}
	}
	recs := l.ReadFrom(2)
	if len(recs) != 3 || recs[0].Offset != 2 || recs[2].Offset != 4 {
		t.Fatalf("ReadFrom(2) = %+v", recs)
	}
	if recs[0].Value[0] != 2 {
		t.Fatalf("value mismatch: %+v", recs[0])
	}
}

func TestTruncateWithoutRetainers(t *testing.T) {
	l := New()
	for i := 0; i < 10; i++ {
		l.Append("k", []byte{byte(i)})
	}
	if base := l.Truncate(7); base != 7 {
		t.Fatalf("base = %d, want 7", base)
	}
	if got := l.ReadFrom(0); len(got) != 3 || got[0].Offset != 7 {
		t.Fatalf("ReadFrom(0) = %+v", got)
	}
	// No retainers: truncating past the end drops everything.
	if base := l.Truncate(100); base != 10 {
		t.Fatalf("base = %d, want 10", base)
	}
	if got := l.ReadFrom(0); len(got) != 0 {
		t.Fatalf("expected empty log, got %+v", got)
	}
}

func TestSnapshotPinsRecords(t *testing.T) {
	l := New()
	for i := 0; i < 6; i++ {
		l.Append("k", []byte{byte(i)})
	}
	l.Truncate(3)
	snap := l.PublishSnapshot()
	if snap.From != 3 || snap.UpTo != 6 {
		t.Fatalf("snapshot = %+v", snap)
	}
	for i := 6; i < 10; i++ {
		l.Append("k", []byte{byte(i)})
	}
	// Reclamation must not pass the snapshot's needed offset.
	if base := l.Truncate(9); base != 3 {
		t.Fatalf("base = %d, want 3 (pinned by snapshot)", base)
	}
	if !l.DiscardSnapshot(snap.ID) {
		t.Fatal("discard failed")
	}
	if l.DiscardSnapshot(snap.ID) {
		t.Fatal("double discard should report false")
	}
	if base := l.Truncate(9); base != 9 {
		t.Fatalf("base = %d, want 9 after discard", base)
	}
}

func TestLeasePinsRecords(t *testing.T) {
	l := New()
	for i := 0; i < 5; i++ {
		l.Append("k", []byte{byte(i)})
	}
	l.Truncate(2)
	lease := l.Acquire("reader")
	if lease.From != 2 {
		t.Fatalf("lease.From = %d, want 2", lease.From)
	}
	if base := l.Truncate(5); base != 2 {
		t.Fatalf("base = %d, want 2 (pinned by lease)", base)
	}
	if !l.Release(lease) {
		t.Fatal("release failed")
	}
	if base := l.Truncate(5); base != 5 {
		t.Fatalf("base = %d, want 5 after release", base)
	}
}

func TestStaleLeaseCannotReleaseOrRenew(t *testing.T) {
	l := New()
	l.Append("k", []byte("v0"))
	old := l.Acquire("reader")
	l.Append("k", []byte("v1"))
	cur := l.Acquire("reader") // same name, new generation
	if old.Token == cur.Token {
		t.Fatal("tokens must differ across generations")
	}
	// Releasing the stale handle must not drop the current lease.
	if l.Release(old) {
		t.Fatal("stale release reported success")
	}
	if !l.Renew(cur) {
		t.Fatal("current lease was dropped by stale release")
	}
	if l.Renew(old) {
		t.Fatal("stale lease renewed")
	}
	// The current lease still pins records.
	if base := l.Truncate(2); base != cur.From {
		t.Fatalf("base = %d, want %d (pinned by current lease)", base, cur.From)
	}
	if !l.Release(cur) {
		t.Fatal("current release failed")
	}
	if l.Release(cur) {
		t.Fatal("double release should report false")
	}
	if base := l.Truncate(2); base != 2 {
		t.Fatalf("base = %d, want 2 after release", base)
	}
}

// TestConcurrentStaleRelease hammers the race between releasing a stale
// lease handle and renewing the current same-name lease. The stale release
// must never win.
func TestConcurrentStaleRelease(t *testing.T) {
	for i := 0; i < 2000; i++ {
		l := New()
		l.Append("k", []byte("v"))
		stale := l.Acquire("r")
		cur := l.Acquire("r")
		bar := newBarrier(3)
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			bar.await()
			l.Release(stale)
		}()
		go func() {
			defer wg.Done()
			bar.await()
			l.Release(stale)
		}()
		bar.await()
		wg.Wait()
		if !l.Renew(cur) {
			t.Fatalf("iter %d: stale release dropped current lease", i)
		}
		if !l.Release(cur) {
			t.Fatalf("iter %d: current release failed", i)
		}
	}
}
