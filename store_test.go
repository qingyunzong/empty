package coverage

import (
	"math/rand"
	"reflect"
	"testing"
)

func TestSnapshotBranchesDiverge(t *testing.T) {
	base := NewStore()
	base.Add("a", Interval{L: 0, R: 5, W: 1})
	snap := base.Snapshot()

	base.Add("b", Interval{L: 1, R: 2, W: 3})
	base.Remove("a")
	snap.Add("c", Interval{L: 2, R: 4, W: -1})

	wantBase := NewStore()
	wantBase.Add("b", Interval{L: 1, R: 2, W: 3})
	if !reflect.DeepEqual(base.srcs, wantBase.srcs) {
		t.Fatalf("base = %+v, want %+v", base.srcs, wantBase.srcs)
	}
	wantSnap := NewStore()
	wantSnap.Add("a", Interval{L: 0, R: 5, W: 1})
	wantSnap.Add("c", Interval{L: 2, R: 4, W: -1})
	if !reflect.DeepEqual(snap.srcs, wantSnap.srcs) {
		t.Fatalf("snap = %+v, want %+v", snap.srcs, wantSnap.srcs)
	}
	checkAgainstScan(t, base)
	checkAgainstScan(t, snap)
}

// TestSnapshotSharesNoSlice checks that appending to a source after a
// snapshot does not leak into the snapshot through a shared slice.
func TestSnapshotSharesNoSlice(t *testing.T) {
	base := NewStore()
	base.Add("a", Interval{L: 0, R: 5, W: 1})
	snap := base.Snapshot()
	base.Add("a", Interval{L: 5, R: 7, W: 2})

	want := NewStore()
	want.Add("a", Interval{L: 0, R: 5, W: 1})
	if !reflect.DeepEqual(snap.srcs, want.srcs) {
		t.Fatalf("snap = %+v, want %+v", snap.srcs, want.srcs)
	}
	checkAgainstScan(t, snap)
	checkAgainstScan(t, base)
}

func TestRemoveSourceWithdrawsAllIntervals(t *testing.T) {
	st := NewStore()
	st.Add("s",
		Interval{L: 0, R: 3, W: 1},
		Interval{L: 5, R: 8, W: 2},
		Interval{L: 10, R: 12, W: -1},
	)
	st.Add("t", Interval{L: 1, R: 2, W: 4})
	if !st.Remove("s") {
		t.Fatal("Remove(s) = false, want true")
	}
	if st.Remove("s") {
		t.Fatal("second Remove(s) = true, want false")
	}
	want := NewStore()
	want.Add("t", Interval{L: 1, R: 2, W: 4})
	if !reflect.DeepEqual(st.srcs, want.srcs) {
		t.Fatalf("store = %+v, want %+v", st.srcs, want.srcs)
	}
	checkAgainstScan(t, st)
}

func TestBatchApplyAndRevert(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	sources := []string{"a", "b", "c", "d"}
	for iter := 0; iter < 2000; iter++ {
		st := randomStore(rng)
		before := st.Snapshot()

		var ops []Op
		for i, n := 0, rng.Intn(6); i < n; i++ {
			src := sources[rng.Intn(len(sources))]
			if rng.Intn(3) == 0 {
				ops = append(ops, RemoveOp(src))
				continue
			}
			var ivs []Interval
			for j, m := 0, 1+rng.Intn(3); j < m; j++ {
				l := rng.Intn(13) - 2
				ivs = append(ivs, Interval{L: l, R: l + rng.Intn(6), W: int64(rng.Intn(7) - 3)})
			}
			ops = append(ops, AddOp(src, ivs...))
		}

		patch := st.Apply(ops...)
		checkAgainstScan(t, st)
		st.Revert(patch)
		if !reflect.DeepEqual(st.srcs, before.srcs) {
			t.Fatalf("iter %d: revert did not restore state:\n got %+v\nwant %+v", iter, st.srcs, before.srcs)
		}
		checkAgainstScan(t, st)
	}
}

func TestBatchDuplicateSourceRevert(t *testing.T) {
	st := NewStore()
	st.Add("a", Interval{L: 0, R: 2, W: 1})
	before := st.Snapshot()

	patch := st.Apply(
		AddOp("a", Interval{L: 2, R: 4, W: 1}),
		RemoveOp("a"),
		AddOp("a", Interval{L: 10, R: 12, W: 9}),
	)
	if got := st.Sources(); !reflect.DeepEqual(got, []string{"a"}) {
		t.Fatalf("sources = %v, want [a]", got)
	}
	st.Revert(patch)
	if !reflect.DeepEqual(st.srcs, before.srcs) {
		t.Fatalf("revert = %+v, want %+v", st.srcs, before.srcs)
	}
}
