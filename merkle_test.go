package merklefs

import (
	"crypto/sha256"
	"fmt"
	"testing"
)

// testManifest builds a manifest of n files with distinct contents.
func testManifest(t *testing.T, n int) *Manifest {
	t.Helper()
	entries := make([]Entry, n)
	for i := 0; i < n; i++ {
		data := fmt.Sprintf("content-%d", i)
		entries[i] = Entry{
			Path:  fmt.Sprintf("file%03d.txt", i),
			Type:  TypeFile,
			Size:  int64(len(data)),
			Hash:  sha256.Sum256([]byte(data)),
			ObjID: objectIDPath(fmt.Sprintf("file%03d.txt", i)),
		}
	}
	m, err := Build(entries)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return m
}

func TestEmptyRoot(t *testing.T) {
	m, err := Build(nil)
	if err != nil {
		t.Fatal(err)
	}
	if m.Root() != sha256.Sum256(nil) {
		t.Fatal("empty root mismatch")
	}
}

func TestRootDeterministicAndOrderIndependent(t *testing.T) {
	m1 := testManifest(t, 7)
	// Same entries inserted in reverse order must yield the same root.
	entries := make([]Entry, 7)
	for i, e := range m1.Entries {
		entries[6-i] = e
	}
	m2, err := Build(entries)
	if err != nil {
		t.Fatal(err)
	}
	if m1.Root() != m2.Root() {
		t.Fatal("root depends on insertion order")
	}
	// Changing one byte of content must change the root.
	m3 := testManifest(t, 7)
	m3.Entries[3].Hash[0] ^= 0xFF
	m3b, err := Build(m3.Entries)
	if err != nil {
		t.Fatal(err)
	}
	if m1.Root() == m3b.Root() {
		t.Fatal("root unchanged after content modification")
	}
}

func TestProveAndVerifyAllEntries(t *testing.T) {
	for _, n := range []int{1, 2, 3, 4, 5, 8, 13, 16, 17, 31} {
		m := testManifest(t, n)
		for i := range m.Entries {
			e := m.Entries[i]
			entry, proof, ok := m.ProvePath(e.Path)
			if !ok {
				t.Fatalf("n=%d: ProvePath(%q) failed", n, e.Path)
			}
			if entry.Path != e.Path {
				t.Fatalf("n=%d: wrong entry returned", n)
			}
			if !VerifyProof(m.Root(), &entry, proof) {
				t.Fatalf("n=%d: proof for %q did not verify", n, e.Path)
			}
		}
	}
}

// TestCorruptionEveryLevel corrupts each proof at each of its levels, plus
// the leaf, the root and the proof structure, and requires rejection.
func TestCorruptionEveryLevel(t *testing.T) {
	m := testManifest(t, 13) // tree depth 4
	root := m.Root()
	for i := range m.Entries {
		entry := m.Entries[i]
		_, proof, ok := m.ProvePath(entry.Path)
		if !ok {
			t.Fatalf("ProvePath(%q)", entry.Path)
		}
		if !VerifyProof(root, &entry, proof) {
			t.Fatalf("entry %d: valid proof rejected", i)
		}
		// Corrupt each level of the proof.
		for lvl := range proof.Steps {
			bad := proof
			bad.Steps = make([]ProofStep, len(proof.Steps))
			copy(bad.Steps, proof.Steps)
			bad.Steps[lvl].Hash[0] ^= 0x01
			if VerifyProof(root, &entry, bad) {
				t.Fatalf("entry %d: corrupted level %d accepted", i, lvl)
			}
			// Flip the side of the sibling at this level.
			bad2 := proof
			bad2.Steps = make([]ProofStep, len(proof.Steps))
			copy(bad2.Steps, proof.Steps)
			bad2.Steps[lvl].Left = !bad2.Steps[lvl].Left
			if VerifyProof(root, &entry, bad2) {
				t.Fatalf("entry %d: flipped side at level %d accepted", i, lvl)
			}
		}
		// Corrupt the leaf (entry content).
		badEntry := entry
		badEntry.Hash[0] ^= 0x01
		if VerifyProof(root, &badEntry, proof) {
			t.Fatalf("entry %d: corrupted leaf accepted", i)
		}
		// Corrupt the claimed path.
		badPath := entry
		badPath.Path += "x"
		if VerifyProof(root, &badPath, proof) {
			t.Fatalf("entry %d: corrupted path accepted", i)
		}
		// Corrupt the root.
		badRoot := root
		badRoot[0] ^= 0x01
		if VerifyProof(badRoot, &entry, proof) {
			t.Fatalf("entry %d: wrong root accepted", i)
		}
		// Corrupt the index.
		badIdx := proof
		badIdx.Index = (proof.Index + 1) % proof.Size
		if VerifyProof(root, &entry, badIdx) {
			t.Fatalf("entry %d: wrong index accepted", i)
		}
		// Truncate and extend the proof.
		if len(proof.Steps) > 0 {
			trunc := proof
			trunc.Steps = proof.Steps[:len(proof.Steps)-1]
			if VerifyProof(root, &entry, trunc) {
				t.Fatalf("entry %d: truncated proof accepted", i)
			}
		}
		ext := proof
		ext.Steps = append(append([]ProofStep{}, proof.Steps...), ProofStep{Hash: sha256.Sum256([]byte("junk"))})
		if VerifyProof(root, &entry, ext) {
			t.Fatalf("entry %d: extended proof accepted", i)
		}
	}
}

func TestVerifyRejectsInconsistentMeta(t *testing.T) {
	m := testManifest(t, 4)
	entry := m.Entries[0]
	_, proof, _ := m.ProvePath(entry.Path)
	for _, bad := range []Proof{
		{Index: -1, Size: 4, Steps: proof.Steps},
		{Index: 0, Size: 0, Steps: proof.Steps},
		{Index: 4, Size: 4, Steps: proof.Steps},
		{Index: 0, Size: 5, Steps: proof.Steps}, // wrong tree size
	} {
		if VerifyProof(m.Root(), &entry, bad) {
			t.Errorf("inconsistent proof meta accepted: %+v", bad)
		}
	}
}

func TestSingleEntryProof(t *testing.T) {
	m := testManifest(t, 1)
	entry := m.Entries[0]
	_, proof, ok := m.ProvePath(entry.Path)
	if !ok {
		t.Fatal("ProvePath failed")
	}
	if len(proof.Steps) != 0 {
		t.Fatalf("single-entry proof has %d steps", len(proof.Steps))
	}
	if !VerifyProof(m.Root(), &entry, proof) {
		t.Fatal("single-entry proof rejected")
	}
}
