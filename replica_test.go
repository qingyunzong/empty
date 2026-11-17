package formal

import "testing"

func TestApplyRejectsStaleWrite(t *testing.T) {
	r := NewReplica("r1")
	r.Apply("k", []Version{{Clock: VClock{"n1": 2}, Value: []byte("new")}})

	// A late replica delivers an obsolete ancestor; it must not overwrite.
	r.Apply("k", []Version{{Clock: VClock{"n1": 1}, Value: []byte("stale")}})

	got := r.Snapshot("k")
	if len(got) != 1 || string(got[0].Value) != "new" {
		t.Fatalf("stale write overwrote newer data: %+v", got)
	}
}

func TestApplyAcceptsConcurrentAndDescendant(t *testing.T) {
	r := NewReplica("r1")
	first := Version{Clock: VClock{"n1": 1}, Value: []byte("a")}
	r.Apply("k", []Version{first})

	parallel := Version{Clock: VClock{"n2": 1}, Value: []byte("b")}
	r.Apply("k", []Version{parallel})
	if got := r.Snapshot("k"); len(got) != 2 {
		t.Fatalf("concurrent write should be retained as sibling, got %d", len(got))
	}

	descendant := Version{Clock: VClock{"n1": 2, "n2": 1}, Value: []byte("c")}
	r.Apply("k", []Version{descendant})
	got := r.Snapshot("k")
	if len(got) != 1 || string(got[0].Value) != "c" {
		t.Fatalf("descendant should resolve siblings, got %+v", got)
	}
}

func TestTombstoneRetainedUntilSafeWatermark(t *testing.T) {
	r := NewReplica("r1")
	tomb := Version{Clock: VClock{"n1": 1}, Tombstone: true, DelEpoch: 5}
	r.Apply("k", []Version{tomb})

	// Below the deletion epoch the tombstone must survive GC.
	r.AdvanceWatermark(4)
	if n := r.GC("k"); n != 0 {
		t.Fatalf("tombstone collected before safe watermark, collected=%d", n)
	}
	if got := r.Snapshot("k"); len(got) != 1 {
		t.Fatal("tombstone must be retained below the safe watermark")
	}

	// At or beyond the deletion epoch it may be collected.
	r.AdvanceWatermark(5)
	if n := r.GC("k"); n != 1 {
		t.Fatalf("expected one tombstone collected, got %d", n)
	}
	if got := r.Snapshot("k"); len(got) != 0 {
		t.Fatalf("expected empty state after GC, got %+v", got)
	}
}

func TestGCBarrierBlocksResurrection(t *testing.T) {
	r := NewReplica("r1")
	tomb := Version{Clock: VClock{"n1": 2}, Tombstone: true, DelEpoch: 1}
	r.Apply("k", []Version{tomb})
	r.AdvanceWatermark(1)
	r.GC("k")

	barrier := r.GCBarrier("k")
	if !EqualClocks(barrier, tomb.Clock) {
		t.Fatalf("barrier should remember the tombstone clock, got %v", barrier)
	}

	// A partitioned replica that never saw the delete now revives the old
	// value; the GC barrier must reject it as stale.
	stale := Version{Clock: VClock{"n1": 1}, Value: []byte("revived")}
	r.Apply("k", []Version{stale})
	if got := r.Snapshot("k"); len(got) != 0 {
		t.Fatalf("stale value resurrected after GC: %+v", got)
	}

	// A genuinely new descendant is still accepted.
	fresh := Version{Clock: VClock{"n1": 3}, Value: []byte("fresh")}
	r.Apply("k", []Version{fresh})
	if got := r.Snapshot("k"); len(got) != 1 || string(got[0].Value) != "fresh" {
		t.Fatalf("new descendant should be accepted past the barrier, got %+v", got)
	}
}

func TestWatermarkNeverMovesBackwards(t *testing.T) {
	r := NewReplica("r1")
	r.AdvanceWatermark(10)
	r.AdvanceWatermark(7)
	if r.Watermark() != 10 {
		t.Fatalf("watermark regressed to %d", r.Watermark())
	}
}
