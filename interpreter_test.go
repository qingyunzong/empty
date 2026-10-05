package backupverify

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func chunkRef(data string) string {
	sum := sha256.Sum256([]byte(data))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func storeWith(datas ...string) MapChunkStore {
	s := MapChunkStore{}
	for _, d := range datas {
		sum := sha256.Sum256([]byte(d))
		s[hex.EncodeToString(sum[:])] = []byte(d)
	}
	return s
}

// chain builds packages linked by parent digests, starting from m.
func chain(m *Manifest, ops ...[]Op) []*Package {
	pkgs := make([]*Package, 0, len(ops))
	head := m.Digest()
	for _, o := range ops {
		p := &Package{Parent: head, Ops: o}
		pkgs = append(pkgs, p)
		head = p.Digest()
	}
	return pkgs
}

func baseManifest() *Manifest {
	return &Manifest{Objects: []ObjectVersion{
		{ID: "alpha", Version: 1, Chunks: []string{chunkRef("a1"), chunkRef("a2")}},
		{ID: "beta", Version: 1, Chunks: []string{chunkRef("b1")}},
	}}
}

func baseStore() MapChunkStore { return storeWith("a1", "a2", "b1", "c1", "c2", "d1") }

func TestValidChain(t *testing.T) {
	m := baseManifest()
	pkgs := chain(m,
		[]Op{{Kind: "put", ID: "alpha", Version: 2, Chunks: []string{chunkRef("c1"), chunkRef("c2")}}},
		[]Op{{Kind: "delete", ID: "beta", Version: 1}},
		[]Op{{Kind: "put", ID: "gamma", Version: 1, Chunks: []string{chunkRef("d1")}}},
	)
	r := Verify(m, pkgs, baseStore())
	if !r.OK() {
		t.Fatalf("expected ok, got edge %v", r.Edge)
	}
	if r.StateDigest == "" || len(r.State) != 4 {
		t.Fatalf("bad state: digest=%q objects=%d", r.StateDigest, len(r.State))
	}
	if !r.State["beta@1"].Deleted {
		t.Fatal("beta@1 should be tombstoned")
	}
	if got := r.State["alpha@2"].Chunks; len(got) != 2 || got[0] != chunkRef("c1") {
		t.Fatalf("alpha@2 chunks = %v", got)
	}
	// Determinism: same input, same digest.
	if again := Verify(m, pkgs, baseStore()); again.StateDigest != r.StateDigest {
		t.Fatal("state digest not deterministic")
	}
}

func TestMissingParentEdge(t *testing.T) {
	m := baseManifest()
	pkgs := chain(m,
		[]Op{{Kind: "put", ID: "gamma", Version: 1, Chunks: []string{chunkRef("d1")}}},
		[]Op{{Kind: "put", ID: "delta", Version: 1, Chunks: []string{chunkRef("d1")}}},
	)
	// Drop the first package: the second now points at a missing parent.
	r := Verify(m, pkgs[1:], baseStore())
	if r.OK() {
		t.Fatal("expected failure")
	}
	if r.Edge.Position != 1 || r.Edge.Reason != ReasonMissingParent {
		t.Fatalf("edge = %+v", r.Edge)
	}
	if r.State != nil || r.StateDigest != "" {
		t.Fatal("no partial restore allowed: state must be empty on failure")
	}
}

func TestVersionConflictEdge(t *testing.T) {
	m := baseManifest()
	good := []Op{{Kind: "put", ID: "gamma", Version: 1, Chunks: []string{chunkRef("d1")}}}
	conflict := []Op{{Kind: "put", ID: "alpha", Version: 1, Chunks: []string{chunkRef("c1")}}}
	pkgs := chain(m, good, conflict)
	r := Verify(m, pkgs, baseStore())
	if r.OK() || r.Edge.Reason != ReasonVersionConflict || r.Edge.Position != 2 {
		t.Fatalf("edge = %+v", r.Edge)
	}
	if r.Edge.Package != pkgs[1].Digest() {
		t.Fatal("edge should name the conflicting package")
	}
}

func TestIdempotentDuplicateVersion(t *testing.T) {
	m := baseManifest()
	dup := []Op{{Kind: "put", ID: "alpha", Version: 1, Chunks: []string{chunkRef("a1"), chunkRef("a2")}}}
	pkgs := chain(m, dup)
	if r := Verify(m, pkgs, baseStore()); !r.OK() {
		t.Fatalf("identical re-put should be a no-op, got %v", r.Edge)
	}
}

func TestDeleteThenReputConflicts(t *testing.T) {
	m := baseManifest()
	pkgs := chain(m,
		[]Op{{Kind: "delete", ID: "alpha", Version: 1}},
		[]Op{{Kind: "put", ID: "alpha", Version: 1, Chunks: []string{chunkRef("a1"), chunkRef("a2")}}},
	)
	r := Verify(m, pkgs, baseStore())
	if r.OK() || r.Edge.Reason != ReasonVersionConflict || r.Edge.Position != 2 {
		t.Fatalf("edge = %+v", r.Edge)
	}
}

func TestManifestDuplicateVersionConflict(t *testing.T) {
	m := &Manifest{Objects: []ObjectVersion{
		{ID: "alpha", Version: 1, Chunks: []string{chunkRef("a1")}},
		{ID: "alpha", Version: 1, Chunks: []string{chunkRef("b1")}},
	}}
	r := Verify(m, nil, baseStore())
	if r.OK() || r.Edge.Position != 0 || r.Edge.Reason != ReasonVersionConflict {
		t.Fatalf("edge = %+v", r.Edge)
	}
}

func TestMissingChunkEdges(t *testing.T) {
	m := baseManifest()

	// Manifest itself references a missing chunk: edge at position 0.
	badManifest := &Manifest{Objects: []ObjectVersion{
		{ID: "alpha", Version: 1, Chunks: []string{chunkRef("nope")}},
	}}
	r := Verify(badManifest, nil, baseStore())
	if r.OK() || r.Edge.Position != 0 || r.Edge.Reason != ReasonMissingChunk {
		t.Fatalf("manifest edge = %+v", r.Edge)
	}

	// Missing chunk in the second package: earliest edge wins even though
	// a later package is also broken.
	pkgs := chain(m,
		[]Op{{Kind: "put", ID: "gamma", Version: 1, Chunks: []string{chunkRef("d1")}}},
		[]Op{{Kind: "put", ID: "delta", Version: 1, Chunks: []string{chunkRef("ghost")}}},
		[]Op{{Kind: "put", ID: "epsilon", Version: 1, Chunks: []string{chunkRef("ghost2")}}},
	)
	r = Verify(m, pkgs, baseStore())
	if r.OK() || r.Edge.Position != 2 || r.Edge.Reason != ReasonMissingChunk {
		t.Fatalf("edge = %+v", r.Edge)
	}
	if r.Edge.Package != pkgs[1].Digest() {
		t.Fatal("edge should name the first broken package")
	}
}

func TestUnknownOp(t *testing.T) {
	m := baseManifest()
	pkgs := chain(m, []Op{{Kind: "frobnicate", ID: "alpha", Version: 9}})
	r := Verify(m, pkgs, baseStore())
	if r.OK() || r.Edge.Reason != ReasonUnknownOp {
		t.Fatalf("edge = %+v", r.Edge)
	}
}

func TestTamperedChunkDetected(t *testing.T) {
	m := baseManifest()
	store := baseStore()
	// Corrupt the stored bytes behind alpha's first chunk.
	sum := sha256.Sum256([]byte("a1"))
	store[hex.EncodeToString(sum[:])] = []byte("tampered")
	r := Verify(m, nil, store)
	if r.OK() || r.Edge.Reason != ReasonMissingChunk {
		t.Fatalf("edge = %+v", r.Edge)
	}
}
