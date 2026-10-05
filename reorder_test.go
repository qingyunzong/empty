package backupverify

import (
	"math/rand"
	"testing"
)

func sampleChain(t *testing.T) (*Manifest, []*Package) {
	t.Helper()
	m := baseManifest()
	pkgs := chain(m,
		[]Op{{Kind: "put", ID: "alpha", Version: 2, Chunks: []string{chunkRef("c1")}}},
		[]Op{{Kind: "delete", ID: "beta", Version: 1}},
		[]Op{{Kind: "put", ID: "gamma", Version: 1, Chunks: []string{chunkRef("d1")}}},
		[]Op{{Kind: "put", ID: "alpha", Version: 3, Chunks: []string{chunkRef("c2")}}},
	)
	return m, pkgs
}

func TestReorderRestoresChain(t *testing.T) {
	m, pkgs := sampleChain(t)
	want := Verify(m, pkgs, baseStore())
	if !want.OK() {
		t.Fatalf("chain should verify: %v", want.Edge)
	}

	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 50; trial++ {
		shuffled := make([]*Package, len(pkgs))
		for i, j := range rng.Perm(len(pkgs)) {
			shuffled[i] = pkgs[j]
		}
		ordered, err := Reorder(m.Digest(), shuffled)
		if err != nil {
			t.Fatalf("reorder: %v", err)
		}
		for i := range ordered {
			if ordered[i] != pkgs[i] {
				t.Fatal("reorder did not restore chain order")
			}
		}
		got := Verify(m, ordered, baseStore())
		if !got.OK() || got.StateDigest != want.StateDigest {
			t.Fatal("reordered verification diverges from serial interpreter")
		}
	}
}

func TestCrossCheckAgreesInOrder(t *testing.T) {
	m, pkgs := sampleChain(t)
	serial, reordered, agree, err := CrossCheck(m, pkgs, baseStore())
	if err != nil || !agree {
		t.Fatalf("agree=%v err=%v", agree, err)
	}
	if !serial.OK() || serial.StateDigest != reordered.StateDigest {
		t.Fatal("serial and reordered results diverge")
	}
}

func TestCrossCheckAgreesOnEarliestEdge(t *testing.T) {
	m := baseManifest()
	pkgs := chain(m,
		[]Op{{Kind: "put", ID: "gamma", Version: 1, Chunks: []string{chunkRef("d1")}}},
		[]Op{{Kind: "put", ID: "alpha", Version: 1, Chunks: []string{chunkRef("c1")}}}, // conflict
		[]Op{{Kind: "put", ID: "delta", Version: 1, Chunks: []string{chunkRef("ghost")}}},
	)
	serial, reordered, agree, err := CrossCheck(m, pkgs, baseStore())
	if err != nil {
		t.Fatalf("cross-check: %v", err)
	}
	if agree != true {
		t.Fatal("in-order corrupted chain: serial and reordered must agree")
	}
	if serial.OK() || serial.Edge.Reason != ReasonVersionConflict || serial.Edge.Position != 2 {
		t.Fatalf("serial edge = %+v", serial.Edge)
	}
	if reordered.Edge.Package != serial.Edge.Package {
		t.Fatal("both interpreters must name the same failing package")
	}
}

func TestReorderBrokenChain(t *testing.T) {
	m, pkgs := sampleChain(t)
	_, err := Reorder(m.Digest(), pkgs[1:]) // first package removed
	if err == nil {
		t.Fatal("expected broken chain error")
	}
	// The serial interpreter independently reports the same gap.
	r := Verify(m, pkgs[1:], baseStore())
	if r.OK() || r.Edge.Reason != ReasonMissingParent || r.Edge.Position != 1 {
		t.Fatalf("serial edge = %+v", r.Edge)
	}
}

func TestReorderFork(t *testing.T) {
	m := baseManifest()
	a := &Package{Parent: m.Digest(), Ops: []Op{{Kind: "put", ID: "x", Version: 1, Chunks: []string{chunkRef("d1")}}}}
	b := &Package{Parent: m.Digest(), Ops: []Op{{Kind: "put", ID: "y", Version: 1, Chunks: []string{chunkRef("d1")}}}}
	if _, err := Reorder(m.Digest(), []*Package{a, b}); err == nil {
		t.Fatal("expected fork error")
	}
}

func TestDirChunkStoreRoundTrip(t *testing.T) {
	dir := DirChunkStore(t.TempDir())
	ref, err := dir.Put([]byte("payload"))
	if err != nil {
		t.Fatal(err)
	}
	if !dir.Has(ref) {
		t.Fatal("stored chunk not found")
	}
	if dir.Has(chunkRef("payload2")) {
		t.Fatal("unexpected hit for absent chunk")
	}
}
