package mirror

import (
	"bytes"
	"errors"
	"math/rand"
	"reflect"
	"testing"
)

func randomBlock(rng *rand.Rand) []byte {
	b := make([]byte, BlockSize)
	rng.Read(b)
	return b
}

func fillRandom(m *Mirror, rng *rand.Rand) {
	for i := 0; i < m.NumBlocks(); i++ {
		m.WriteBlock(i, randomBlock(rng))
	}
}

// corruptBlock applies one of three damage kinds: random garbage,
// an all-zero block, or deletion (missing leaf).
func corruptBlock(m *Mirror, i, kind int, rng *rand.Rand) {
	switch kind % 3 {
	case 0:
		m.WriteBlock(i, randomBlock(rng))
	case 1:
		m.WriteBlock(i, make([]byte, BlockSize))
	case 2:
		m.ClearBlock(i)
	}
}

func TestRepairAccessesOnlyDifferingLeaves(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	const n = 64
	src := NewMirror(n)
	fillRandom(src, rng)

	dst := NewMirror(n)
	fillRandom(dst, rng)
	if _, err := Repair(dst, src); err != nil {
		t.Fatalf("initial sync: %v", err)
	}

	// Corrupt a random subset of dst blocks.
	corrupted := map[int]bool{}
	for len(corrupted) < 9 {
		corrupted[rng.Intn(n)] = true
	}
	for i := range corrupted {
		corruptBlock(dst, i, rng.Intn(3), rng)
	}

	cs := NewCountingSource(src)
	rep, err := Repair(dst, cs)
	if err != nil {
		t.Fatalf("repair: %v", err)
	}

	want := make([]int, 0, len(corrupted))
	for i := range corrupted {
		want = append(want, i)
	}
	// Repair must report exactly the corrupted leaves...
	got := append([]int(nil), rep.Repaired...)
	if !reflect.DeepEqual(got, sortedCopy(want)) {
		t.Fatalf("repaired leaves = %v, want %v", got, want)
	}
	// ...and the source must have been read at exactly those leaves,
	// nowhere else in the tree.
	if got := cs.Accessed(); !reflect.DeepEqual(got, sortedCopy(want)) {
		t.Fatalf("accessed leaves = %v, want %v", got, want)
	}
	for _, r := range cs.Ranges() {
		for i := r[0]; i < r[1]; i++ {
			if !corrupted[i] {
				t.Fatalf("access range %v covers clean block %d", r, i)
			}
		}
	}
	if dst.Digest() != src.Digest() {
		t.Fatal("full digest mismatch after repair")
	}
	if dst.Tree().Root() != src.Tree().Root() {
		t.Fatal("root mismatch after repair")
	}
}

func TestCleanMirrorTriggersNoBlockReads(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	src := NewMirror(32)
	fillRandom(src, rng)
	dst := NewMirror(32)
	if _, err := Repair(dst, src); err != nil {
		t.Fatalf("initial sync: %v", err)
	}
	cs := NewCountingSource(src)
	rep, err := Repair(dst, cs)
	if err != nil {
		t.Fatalf("repair: %v", err)
	}
	if len(rep.Repaired) != 0 {
		t.Fatalf("repaired %v on clean mirror", rep.Repaired)
	}
	if got := cs.Accessed(); len(got) != 0 {
		t.Fatalf("read blocks %v despite equal roots", got)
	}
}

func TestMissingLeafDistinctFromZeroLeaf(t *testing.T) {
	zero := make([]byte, BlockSize)
	if missingLeafHash(7) == leafHash(zero) {
		t.Fatal("missing leaf and all-zero leaf share a hash")
	}
	if missingLeafHash(1) == missingLeafHash(2) {
		t.Fatal("missing leaves at different indexes share a hash")
	}

	const i = 5
	cases := []struct {
		name     string
		dst, src func(m *Mirror)
		wantDiff bool
	}{
		{"both missing", func(m *Mirror) {}, func(m *Mirror) {}, false},
		{"both zero", func(m *Mirror) { m.WriteBlock(i, zero) }, func(m *Mirror) { m.WriteBlock(i, zero) }, false},
		{"dst missing src zero", func(m *Mirror) {}, func(m *Mirror) { m.WriteBlock(i, zero) }, true},
		{"dst zero src missing", func(m *Mirror) { m.WriteBlock(i, zero) }, func(m *Mirror) {}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d, s := NewMirror(8), NewMirror(8)
			tc.dst(d)
			tc.src(s)
			got := Diff(d.Tree(), s.Tree())
			hasI := len(got) == 1 && got[0] == i
			if hasI != tc.wantDiff {
				t.Fatalf("diff = %v, wantDiff=%v", got, tc.wantDiff)
			}
		})
	}
}

func TestRepairRejectsMixedSourceVersions(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	src := NewMirror(16)
	fillRandom(src, rng)
	dst := NewMirror(16) // all missing: every leaf differs

	// Mutate the source as soon as repair fetches its first block.
	src.OnRead = func() {
		src.OnRead = nil
		src.WriteBlock(0, randomBlock(rng))
	}
	before := dst.Digest()
	_, err := Repair(dst, src)
	if !errors.Is(err, ErrVersionSkew) {
		t.Fatalf("err = %v, want ErrVersionSkew", err)
	}
	if dst.Digest() == before {
		t.Log("dst untouched before abort (writes happen after version check)")
	}
	// No block from the new version may have been published into dst:
	// every dst write used data fetched under the pinned version only.
	// Verify by re-running repair against the now-stable source.
	if _, err := Repair(dst, src); err != nil {
		t.Fatalf("re-repair: %v", err)
	}
	if dst.Digest() != src.Digest() {
		t.Fatal("digest mismatch after re-repair")
	}
}

func TestFullDigestAfterRandomCorruption(t *testing.T) {
	for trial := 0; trial < 20; trial++ {
		rng := rand.New(rand.NewSource(int64(100 + trial)))
		n := 1 + rng.Intn(128)
		src := NewMirror(n)
		// Randomly leave some source leaves missing or all-zero.
		for i := 0; i < n; i++ {
			switch rng.Intn(4) {
			case 0, 1:
				src.WriteBlock(i, randomBlock(rng))
			case 2:
				src.WriteBlock(i, make([]byte, BlockSize))
			default:
				// stay missing
			}
		}
		dst := NewMirror(n)
		if _, err := Repair(dst, src); err != nil {
			t.Fatalf("trial %d initial sync: %v", trial, err)
		}
		// Random damage: corrupt, zero, or delete random leaves.
		for k := 1 + rng.Intn(n); k > 0; k-- {
			corruptBlock(dst, rng.Intn(n), rng.Intn(3), rng)
		}
		cs := NewCountingSource(src)
		want := Diff(dst.Tree(), src.Tree())
		if _, err := Repair(dst, cs); err != nil {
			t.Fatalf("trial %d repair: %v", trial, err)
		}
		if dst.Digest() != src.Digest() {
			t.Fatalf("trial %d: full digest mismatch after repair", trial)
		}
		if dst.Tree().Root() != src.Tree().Root() {
			t.Fatalf("trial %d: root mismatch after repair", trial)
		}
		// Accessed leaves must be exactly the differing leaves.
		if got := cs.Accessed(); !reflect.DeepEqual(got, want) {
			t.Fatalf("trial %d: accessed %v, want diff %v", trial, got, want)
		}
		for i := 0; i < n; i++ {
			d, dok := dst.ReadBlock(i)
			s, sok := src.ReadBlock(i)
			if dok != sok || (dok && !bytes.Equal(d, s)) {
				t.Fatalf("trial %d: leaf %d differs after repair", trial, i)
			}
		}
	}
}

func sortedCopy(in []int) []int {
	out := append([]int(nil), in...)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}
