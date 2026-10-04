package workload

import (
	"testing"
)

// TestRandomHistoriesAgainstModel replays many seeded random fork
// histories and requires byte-identical reads against the deep-copy
// model plus exact page reclamation once everything is closed.
func TestRandomHistoriesAgainstModel(t *testing.T) {
	for seed := int64(1); seed <= 25; seed++ {
		res, err := Run(Config{
			Seed:       seed,
			Ops:        3000,
			MaxSnaps:   24,
			MaxPages:   48,
			MaxWrite:   700,
			CloseAtEnd: true,
		})
		if err != nil {
			t.Fatalf("seed=%d: %v", seed, err)
		}
		if res.Stats.LivePages != 0 {
			t.Fatalf("seed=%d: %d pages leaked", seed, res.Stats.LivePages)
		}
		if res.Stats.CowCopies == 0 {
			t.Fatalf("seed=%d: workload never exercised copy-on-write", seed)
		}
	}
}

// TestKeepOpenRefcounts runs without closing at the end: pages referenced
// by surviving snapshots must remain allocated with exact refcounts.
func TestKeepOpenRefcounts(t *testing.T) {
	res, err := Run(Config{
		Seed:       99,
		Ops:        4000,
		MaxSnaps:   32,
		MaxPages:   32,
		MaxWrite:   256,
		CloseAtEnd: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Live) == 0 {
		t.Fatal("expected surviving snapshots")
	}
	if err := res.Store.VerifyRefCounts(); err != nil {
		t.Fatal(err)
	}
	st := res.Stats
	if st.LivePages == 0 {
		t.Fatal("pages reclaimed while views still alive")
	}
	var sum uint64
	for _, refs := range res.Store.RefTable() {
		sum += uint64(refs)
	}
	if sum != st.TotalRefs {
		t.Fatalf("ref table sums to %d, stats say %d", sum, st.TotalRefs)
	}
}
