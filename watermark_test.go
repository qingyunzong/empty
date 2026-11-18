package formal

import "testing"

func commitKV(t *testing.T, eng *Engine, kvs ...[2]string) uint64 {
	t.Helper()
	tx := eng.Begin()
	for _, kv := range kvs {
		tx.Write(kv[0], kv[1])
	}
	return tx.Commit()
}

func TestSafeWatermarkMonotonic(t *testing.T) {
	eng := NewEngine()

	hold := eng.Begin() // snap 0, pins the watermark
	ts1 := commitKV(t, eng, [2]string{"a", "v1"})
	if got := eng.SafeTS(); got != 0 {
		t.Fatalf("safe = %d, want 0 while snapshot 0 is active", got)
	}

	reader := eng.Begin() // snap = ts1
	hold.Rollback()
	if got := eng.SafeTS(); got != ts1 {
		t.Fatalf("safe = %d, want %d (oldest active snapshot)", got, ts1)
	}

	ts2 := commitKV(t, eng, [2]string{"a", "v2"})
	if got := eng.SafeTS(); got != ts1 {
		t.Fatalf("safe = %d, want %d (commit must not skip past active snapshot)", got, ts1)
	}

	reader.Rollback()
	if got := eng.SafeTS(); got != ts2 {
		t.Fatalf("safe = %d, want %d (no active snapshots, clock rules)", got, ts2)
	}

	// Watermark never regresses from here on.
	last := eng.SafeTS()
	for i := 0; i < 10; i++ {
		commitKV(t, eng, [2]string{"a", "vx"})
		if got := eng.SafeTS(); got < last {
			t.Fatalf("watermark regressed: %d -> %d", last, got)
		}
		last = eng.SafeTS()
	}
}

func TestReclaimedBytesOneToOne(t *testing.T) {
	eng := NewEngine()

	commitKV(t, eng, [2]string{"a", "111"})   // ts 1, 4 bytes
	commitKV(t, eng, [2]string{"a", "22222"}) // ts 2, 6 bytes
	commitKV(t, eng, [2]string{"b", "x"})     // ts 3, 2 bytes

	st := eng.GC()
	if st.Versions != 1 || st.Bytes != 4 {
		t.Fatalf("GC reclaimed (%d, %d bytes), want (1, 4 bytes)", st.Versions, st.Bytes)
	}

	// A held snapshot at ts 3 pins a@2: committing a@4 must not reclaim it.
	hold := eng.Begin()
	commitKV(t, eng, [2]string{"a", "3333333"}) // ts 4, 8 bytes
	st = eng.GC()
	if st.Versions != 0 || st.Bytes != 0 {
		t.Fatalf("GC reclaimed (%d, %d bytes) under a pinning snapshot, want (0, 0)", st.Versions, st.Bytes)
	}
	if v, ok := hold.Get("a"); !ok || string(v.Val) != "22222" {
		t.Fatalf("pinned snapshot reads %v, want a@2", v)
	}

	hold.Rollback()
	st = eng.GC()
	if st.Versions != 1 || st.Bytes != 6 {
		t.Fatalf("GC reclaimed (%d, %d bytes) after release, want (1, 6 bytes)", st.Versions, st.Bytes)
	}

	s := eng.Stats()
	if s.TotalBytes != 20 || s.ReclaimedBytes != 10 || s.LiveBytes != 10 {
		t.Fatalf("accounting: total=%d reclaimed=%d live=%d, want 20/10/10",
			s.TotalBytes, s.ReclaimedBytes, s.LiveBytes)
	}
	if s.TotalVersions != 4 || s.ReclaimedVersions != 2 || s.LiveVersions != 2 {
		t.Fatalf("version counts: total=%d reclaimed=%d live=%d, want 4/2/2",
			s.TotalVersions, s.ReclaimedVersions, s.LiveVersions)
	}
}

func TestSnapshotReads(t *testing.T) {
	eng := NewEngine()
	commitKV(t, eng, [2]string{"a", "first"}, [2]string{"b", "bee"})
	snap := eng.Begin()
	commitKV(t, eng, [2]string{"a", "second"})

	if v, ok := snap.Get("a"); !ok || string(v.Val) != "first" {
		t.Fatalf("snapshot reads a=%q, want %q", v.Val, "first")
	}
	got := snap.Scan("", "")
	if len(got) != 2 || string(got[0].Val) != "first" || string(got[1].Val) != "bee" {
		t.Fatalf("snapshot scan = %v, want a=first b=bee", got)
	}
	snap.Rollback()
}
