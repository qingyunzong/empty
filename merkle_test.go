package manifest

import (
	"crypto/sha256"
	"fmt"
	"path/filepath"
	"testing"
)

func buildTree(t *testing.T, n int) (*Manifest, string) {
	t.Helper()
	root := t.TempDir()
	for i := 0; i < n; i++ {
		writeFile(t, filepath.Join(root, fmt.Sprintf("file-%03d.txt", i)), fmt.Sprintf("content-%d", i))
	}
	m, err := Build(root)
	if err != nil {
		t.Fatal(err)
	}
	return m, root
}

func TestProveAndVerifyEveryEntry(t *testing.T) {
	m, _ := buildTree(t, 20)
	root := m.Root()
	for _, e := range m.Entries() {
		proof, entry, err := m.Prove(e.Path)
		if err != nil {
			t.Fatal(err)
		}
		if entry != e {
			t.Fatalf("Prove returned wrong entry for %q", e.Path)
		}
		if !VerifyEntry(root, e, proof) {
			t.Fatalf("valid proof rejected for %q", e.Path)
		}
	}
}

func TestCorruptionAtEveryLevelRejected(t *testing.T) {
	m, _ := buildTree(t, 20)
	root := m.Root()
	target := "file-007.txt"
	proof, entry, err := m.Prove(target)
	if err != nil {
		t.Fatal(err)
	}
	if len(proof.Steps) < 3 {
		t.Fatalf("tree too shallow for level-by-level test: %d steps", len(proof.Steps))
	}

	// Corrupt the sibling hash at each level of the proof.
	for level := range proof.Steps {
		bad := proof
		bad.Steps = make([]ProofStep, len(proof.Steps))
		copy(bad.Steps, proof.Steps)
		bad.Steps[level].Hash[0] ^= 0xff
		if VerifyEntry(root, entry, bad) {
			t.Fatalf("corrupted sibling at level %d accepted", level)
		}
		// Flip the direction bit at this level.
		bad2 := proof
		bad2.Steps = make([]ProofStep, len(proof.Steps))
		copy(bad2.Steps, proof.Steps)
		bad2.Steps[level].Left = !bad2.Steps[level].Left
		if VerifyEntry(root, entry, bad2) {
			t.Fatalf("flipped direction at level %d accepted", level)
		}
	}

	// Corrupt the leaf itself.
	tampered := entry
	tampered.Size++
	if VerifyEntry(root, tampered, proof) {
		t.Fatal("tampered entry accepted")
	}

	// Wrong root.
	var wrongRoot [32]byte
	copy(wrongRoot[:], root[:])
	wrongRoot[0] ^= 0xff
	if VerifyEntry(wrongRoot, entry, proof) {
		t.Fatal("proof accepted against wrong root")
	}

	// Wrong leaf index.
	badIdx := proof
	badIdx.LeafIndex = (proof.LeafIndex + 1) % proof.TreeSize
	if VerifyEntry(root, entry, badIdx) {
		t.Fatal("wrong leaf index accepted")
	}

	// Wrong tree size.
	badSize := proof
	badSize.TreeSize++
	if VerifyEntry(root, entry, badSize) {
		t.Fatal("wrong tree size accepted")
	}

	// Truncated and extended proofs.
	trunc := proof
	trunc.Steps = proof.Steps[:len(proof.Steps)-1]
	if VerifyEntry(root, entry, trunc) {
		t.Fatal("truncated proof accepted")
	}
	ext := proof
	ext.Steps = append(append([]ProofStep{}, proof.Steps...), ProofStep{Hash: sha256.Sum256([]byte("extra"))})
	if VerifyEntry(root, entry, ext) {
		t.Fatal("extended proof accepted")
	}
}

func TestOddTreePromotion(t *testing.T) {
	for _, n := range []int{1, 2, 3, 5, 7, 9, 13, 17} {
		m, _ := buildTree(t, n)
		root := m.Root()
		for _, e := range m.Entries() {
			proof, entry, err := m.Prove(e.Path)
			if err != nil {
				t.Fatal(err)
			}
			if !VerifyEntry(root, entry, proof) {
				t.Fatalf("n=%d: proof for %q rejected", n, e.Path)
			}
		}
	}
}

func TestEmptyAndSingleEntryTrees(t *testing.T) {
	m, err := Build(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if m.Root() != RootOf(nil) {
		t.Fatal("empty tree root mismatch")
	}
	if _, _, err := m.Prove("anything"); err == nil {
		t.Fatal("expected error proving entry in empty tree")
	}

	m, _ = buildTree(t, 1)
	root := m.Root()
	proof, entry, err := m.Prove("file-000.txt")
	if err != nil {
		t.Fatal(err)
	}
	if len(proof.Steps) != 0 {
		t.Fatal("single-leaf proof must have no steps")
	}
	if !VerifyEntry(root, entry, proof) {
		t.Fatal("single-leaf proof rejected")
	}
	if m.Root() != RootOf([][32]byte{LeafHash(entry)}) {
		t.Fatal("single-leaf root mismatch")
	}
}

func TestProofDeterministicAcrossBuilds(t *testing.T) {
	m1, root := buildTree(t, 10)
	m2, err := Build(root)
	if err != nil {
		t.Fatal(err)
	}
	if m1.Root() != m2.Root() {
		t.Fatal("rebuild of unchanged tree produced a different root")
	}
}
