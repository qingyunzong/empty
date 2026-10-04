package kvmerge

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"
)

func decisionFor(t *testing.T, res Result, key string, seq uint64) Decision {
	t.Helper()
	for _, d := range res.Decisions {
		if d.Entry.Key == key && d.Entry.Seq == seq {
			return d
		}
	}
	t.Fatalf("no decision for %s@%d", key, seq)
	return Decision{}
}

func TestTombstoneRetainedForPinnedReader(t *testing.T) {
	seg := NewSegment([]Entry{
		{Key: "k", Seq: 1, Val: "a"},
		{Key: "k", Seq: 5, Del: true},
	})
	reg := NewRegistry()
	reg.Register(3) // reader pinned before the tombstone

	res := Merge([]Segment{seg}, reg, true)

	put := decisionFor(t, res, "k", 1)
	if !put.Kept || !strings.Contains(put.Reason, "reader at seq 3") {
		t.Fatalf("put@1 should be kept for the pinned reader, got %+v", put)
	}
	tomb := decisionFor(t, res, "k", 5)
	if !tomb.Kept || !strings.Contains(tomb.Reason, "newest version") {
		t.Fatalf("tombstone@5 should be kept as newest, got %+v", tomb)
	}
	if len(res.Segment.Entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(res.Segment.Entries))
	}
	if v, ok := res.Segment.Get("k", 3); !ok || v != "a" {
		t.Fatalf("reader at 3 should see a, got %q %v", v, ok)
	}
	if _, ok := res.Segment.Get("k", 5); ok {
		t.Fatal("reader at 5 should see deletion")
	}

	// Once the reader leaves, a second merge collects the whole key.
	res2 := Merge([]Segment{res.Segment}, NewRegistry(), true)
	if len(res2.Segment.Entries) != 0 {
		t.Fatalf("expected key fully collected, got %v", res2.Segment.Entries)
	}
	d := decisionFor(t, res2, "k", 5)
	if d.Kept || !strings.Contains(d.Reason, "collected") {
		t.Fatalf("tombstone should be collected, got %+v", d)
	}
}

func TestMiddleTombstoneSuperseded(t *testing.T) {
	seg := NewSegment([]Entry{
		{Key: "k", Seq: 1, Val: "a"},
		{Key: "k", Seq: 2, Del: true},
		{Key: "k", Seq: 3, Val: "b"},
	})
	res := Merge([]Segment{seg}, NewRegistry(), true)

	if len(res.Segment.Entries) != 1 || res.Segment.Entries[0].Seq != 3 {
		t.Fatalf("only put@3 should survive, got %v", res.Segment.Entries)
	}
	d := decisionFor(t, res, "k", 2)
	if d.Kept || !strings.Contains(d.Reason, "superseded") {
		t.Fatalf("middle tombstone should be dropped as superseded, got %+v", d)
	}
}

func TestShadowedByRetainedTombstone(t *testing.T) {
	seg := NewSegment([]Entry{
		{Key: "k", Seq: 1, Val: "a"},
		{Key: "k", Seq: 2, Del: true},
		{Key: "k", Seq: 5, Val: "b"},
	})
	reg := NewRegistry()
	reg.Register(3) // sees the deletion at seq 2

	res := Merge([]Segment{seg}, reg, true)
	d := decisionFor(t, res, "k", 1)
	if d.Kept || !strings.Contains(d.Reason, "shadowed by retained tombstone at seq 2") {
		t.Fatalf("put@1 should be shadowed by the retained tombstone, got %+v", d)
	}
	if _, ok := res.Segment.Get("k", 3); ok {
		t.Fatal("reader at 3 should see deletion")
	}
}

func TestTombstoneShieldsUnmergedLowerSegments(t *testing.T) {
	lower := NewSegment([]Entry{{Key: "k", Seq: 1, Val: "old"}})
	upper := NewSegment([]Entry{{Key: "k", Seq: 2, Del: true}})

	// Merge only the upper segment; the lower one stays unmerged.
	res := Merge([]Segment{upper}, NewRegistry(), false)
	if len(res.Segment.Entries) != 1 {
		t.Fatalf("tombstone must survive while lower segments exist, got %v", res.Segment.Entries)
	}
	d := decisionFor(t, res, "k", 2)
	if !strings.Contains(d.Reason, "unmerged lower segments") {
		t.Fatalf("reason should cite unmerged lower segments, got %q", d.Reason)
	}
	// Combined view still reports the deletion.
	if _, ok := res.Segment.Get("k", 100); ok {
		t.Fatal("tombstone should hide the value")
	}
	_ = lower
}

func TestRandomLayeredMatchesModel(t *testing.T) {
	for seed := int64(1); seed <= 25; seed++ {
		rng := rand.New(rand.NewSource(seed))
		var keys []string
		for i := 0; i < 30; i++ {
			keys = append(keys, fmt.Sprintf("k%02d", i))
		}
		model := NewModel()
		const n = 600
		var ops []Entry
		for i := 0; i < n; i++ {
			e := Entry{Key: keys[rng.Intn(len(keys))], Seq: uint64(i + 1)}
			if rng.Intn(4) == 0 {
				e.Del = true
			} else {
				e.Val = fmt.Sprintf("v%d", i)
			}
			ops = append(ops, e)
			model.Apply(e)
		}

		// Split the op stream into 5 layered segments, newest first.
		var layers []Segment
		const numLayers = 5
		for l := numLayers - 1; l >= 0; l-- {
			lo := l * n / numLayers
			hi := (l + 1) * n / numLayers
			layers = append(layers, NewSegment(ops[lo:hi]))
		}

		reg := NewRegistry()
		var readerSeqs []uint64
		for i := 0; i < 8; i++ {
			s := uint64(rng.Intn(n + 1))
			reg.Register(s)
			readerSeqs = append(readerSeqs, s)
		}

		res := Merge(layers, reg, true)
		for _, d := range res.Decisions {
			if d.Reason == "" {
				t.Fatalf("seed %d: empty reason for %+v", seed, d.Entry)
			}
		}

		checkSeqs := append(append([]uint64{}, readerSeqs...), uint64(n))
		for _, s := range checkSeqs {
			for _, k := range keys {
				gotV, gotOK := res.Segment.Get(k, s)
				wantV, wantOK := model.Get(k, s)
				if gotV != wantV || gotOK != wantOK {
					t.Fatalf("seed %d key %s seq %d: got (%q,%v), model wants (%q,%v)",
						seed, k, s, gotV, gotOK, wantV, wantOK)
				}
			}
		}

		// Second generation: all readers gone, re-merge the output.
		res2 := Merge([]Segment{res.Segment}, NewRegistry(), true)
		for _, k := range keys {
			gotV, gotOK := res2.Segment.Get(k, uint64(n))
			wantV, wantOK := model.Get(k, uint64(n))
			if gotV != wantV || gotOK != wantOK {
				t.Fatalf("seed %d gen2 key %s: got (%q,%v), model wants (%q,%v)",
					seed, k, gotV, gotOK, wantV, wantOK)
			}
		}
		if seed == 1 {
			for _, d := range res.Decisions[:8] {
				t.Logf("kept=%v %-4s seq=%-3d del=%v reason=%s",
					d.Kept, d.Entry.Key, d.Entry.Seq, d.Entry.Del, d.Reason)
			}
		}
	}
}
