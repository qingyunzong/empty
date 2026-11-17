package formal

import "testing"

func TestVClockMergeAndDescend(t *testing.T) {
	a := VClock{"n1": 2, "n2": 1}
	b := VClock{"n1": 1, "n3": 3}

	merged := MergeClocks(a, b)
	want := VClock{"n1": 2, "n2": 1, "n3": 3}
	if !EqualClocks(merged, want) {
		t.Fatalf("merge = %v, want %v", merged, want)
	}

	if !Descends(a, VClock{"n1": 1}) {
		t.Fatal("a should descend its ancestor")
	}
	if Descends(a, b) || Descends(b, a) {
		t.Fatal("a and b should be concurrent")
	}
	if !Concurrent(a, b) {
		t.Fatal("Concurrent() mismatch")
	}

	next := a.Increment("n1")
	if next.Get("n1") != 3 || a.Get("n1") != 2 {
		t.Fatal("Increment must return a new clock without mutating the source")
	}
}

func TestMergeVersionsPrunesAncestors(t *testing.T) {
	old := Version{Clock: VClock{"n1": 1}, Value: []byte("v1")}
	newer := Version{Clock: VClock{"n1": 2}, Value: []byte("v2")}

	got := MergeVersions([]Version{newer}, []Version{old})
	if len(got) != 1 || !EqualClocks(got[0].Clock, newer.Clock) {
		t.Fatalf("ancestor must be pruned, got %+v", got)
	}

	// Reverse order must converge to the same result.
	got = MergeVersions([]Version{old}, []Version{newer})
	if len(got) != 1 || !EqualClocks(got[0].Clock, newer.Clock) {
		t.Fatalf("newer revision must replace ancestor, got %+v", got)
	}
}

func TestMergeVersionsKeepsConcurrentSiblings(t *testing.T) {
	sibA := Version{Clock: VClock{"n1": 2}, Value: []byte("a")}
	sibB := Version{Clock: VClock{"n2": 2}, Value: []byte("b")}

	got := MergeVersions([]Version{sibA}, []Version{sibB})
	if len(got) != 2 {
		t.Fatalf("concurrent writes must form a sibling set of 2, got %d", len(got))
	}

	// Merging again is idempotent and deterministic.
	again := MergeVersions(got, got)
	if len(again) != 2 {
		t.Fatalf("re-merge should stay at 2 siblings, got %d", len(again))
	}
}

func TestMergeVersionsEqualClockTombstoneWins(t *testing.T) {
	clock := VClock{"n1": 1}
	live := Version{Clock: clock, Value: []byte("v1")}
	tomb := Version{Clock: clock.Copy(), Tombstone: true, DelEpoch: 1}

	got := MergeVersions([]Version{live}, []Version{tomb})
	if len(got) != 1 || !got[0].Tombstone {
		t.Fatalf("equal-clock tombstone must collapse the live value, got %+v", got)
	}

	got = MergeVersions([]Version{tomb}, []Version{live})
	if len(got) != 1 || !got[0].Tombstone {
		t.Fatalf("tombstone must still win regardless of merge order, got %+v", got)
	}
}

func TestVisibleHidesTombstones(t *testing.T) {
	tomb := Version{Clock: VClock{"n1": 2}, Tombstone: true}
	live := Version{Clock: VClock{"n1": 1}, Value: []byte("stale")}

	visible, deleted := Visible([]Version{tomb, live})
	if deleted != true {
		t.Fatal("dominating tombstone must report deleted")
	}
	if len(visible) != 0 {
		t.Fatalf("stale live value under a tombstone must be hidden, got %+v", visible)
	}
}

func TestVisibleConcurrentTombstoneKeepsSibling(t *testing.T) {
	tomb := Version{Clock: VClock{"n1": 1}, Tombstone: true}
	live := Version{Clock: VClock{"n2": 1}, Value: []byte("parallel")}

	visible, deleted := Visible([]Version{tomb, live})
	if !deleted || len(visible) != 1 {
		t.Fatalf("concurrent tombstone/live should yield 1 live sibling + deleted, got %d/%v", len(visible), deleted)
	}
}
