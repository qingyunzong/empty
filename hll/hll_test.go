package hll

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"testing"
)

const testSeed uint64 = 0x9E3779B97F4A7C15

// fixedItems deterministically generates n distinct items so every test run
// (and every machine) validates against the same dataset.
func fixedItems(n int) [][]byte {
	items := make([][]byte, n)
	for i := range items {
		items[i] = []byte(fmt.Sprintf("dlks-de-0106/item-%08d", i))
	}
	return items
}

func build(p uint8, seed uint64, items [][]byte) *Sketch {
	s, err := New(p, seed)
	if err != nil {
		panic(err)
	}
	for _, it := range items {
		s.Add(it)
	}
	return s
}

func relErr(got, want uint64) float64 {
	return math.Abs(float64(got)-float64(want)) / float64(want)
}

// TestEstimateAccuracy checks the estimation error on a fixed dataset
// against the theoretical HLL standard error 1.04/sqrt(m) with a 4-sigma
// bound.
func TestEstimateAccuracy(t *testing.T) {
	const n = 100000
	items := fixedItems(n)
	for _, p := range []uint8{10, 12, 14, 16} {
		s := build(p, testSeed, items)
		if s.IsSparse() {
			t.Fatalf("p=%d: expected dense sketch after %d items", p, n)
		}
		est := s.Estimate()
		bound := 4 * 1.04 / math.Sqrt(float64(uint64(1)<<p))
		if e := relErr(est, n); e > bound {
			t.Errorf("p=%d: estimate %d, relative error %.4f exceeds bound %.4f", p, est, e, bound)
		}
	}
}

// TestSparseEstimate covers the sparse path and linear-counting range.
func TestSparseEstimate(t *testing.T) {
	for _, n := range []int{1, 10, 100, 500} {
		s := build(14, testSeed, fixedItems(n))
		if !s.IsSparse() {
			t.Fatalf("n=%d: expected sparse sketch", n)
		}
		if est := s.Estimate(); relErr(est, uint64(n)) > 0.05 {
			t.Errorf("n=%d: sparse estimate %d off by more than 5%%", n, est)
		}
	}
}

// TestSparseDenseTransition verifies that converting from sparse to dense
// (by crossing the size threshold) preserves the sketch state exactly.
func TestSparseDenseTransition(t *testing.T) {
	items := fixedItems(2000)
	s := build(12, testSeed, items)
	if s.IsSparse() {
		t.Fatal("expected conversion to dense")
	}
	// Rebuild the dense state purely from the sparse encoding of the same
	// hashes and compare register by register.
	ref := &Sketch{p: 12, seed: testSeed, sparse: true, tmpSet: newSparseList()}
	for _, it := range items {
		ref.tmpSet.add(encodeHash(hash64(it, testSeed), 12))
	}
	regs := make([]uint8, 1<<12)
	ref.tmpSet.decodeTo(12, regs)
	if !bytes.Equal(s.regs, regs) {
		t.Fatal("dense registers after transition differ from sparse decoding")
	}
}

// TestReducePrecisionMatchesDirectBuild verifies the register mapping: a
// dense sketch reduced from p=16 to p2 must be identical to a sketch built
// directly at p2 from the same hashes.
func TestReducePrecisionMatchesDirectBuild(t *testing.T) {
	items := fixedItems(50000)
	hi := build(16, testSeed, items)
	for _, p2 := range []uint8{10, 12, 14} {
		reduced, err := hi.ReducePrecision(p2)
		if err != nil {
			t.Fatalf("ReducePrecision(%d): %v", p2, err)
		}
		direct := build(p2, testSeed, items)
		if !reduced.Equal(direct) {
			t.Fatalf("p2=%d: reduced sketch differs from direct build", p2)
		}
		if reduced.Estimate() != direct.Estimate() {
			t.Fatalf("p2=%d: estimates differ: %d vs %d", p2, reduced.Estimate(), direct.Estimate())
		}
	}
}

func TestReducePrecisionRejectsIncrease(t *testing.T) {
	s := build(10, testSeed, fixedItems(100))
	if _, err := s.ReducePrecision(12); !errors.Is(err, ErrPrecisionIncrease) {
		t.Fatalf("expected ErrPrecisionIncrease, got %v", err)
	}
	if _, err := s.ReducePrecision(10); err != nil {
		t.Fatalf("same precision should clone, got %v", err)
	}
}

func TestMergeGuards(t *testing.T) {
	a := build(12, 1, fixedItems(100))
	b := build(12, 2, fixedItems(100))
	if err := a.Merge(b); !errors.Is(err, ErrSeedMismatch) {
		t.Fatalf("expected ErrSeedMismatch, got %v", err)
	}
	c := build(14, 1, fixedItems(100))
	if err := a.Merge(c); !errors.Is(err, ErrPrecisionMismatch) {
		t.Fatalf("expected ErrPrecisionMismatch, got %v", err)
	}
}

// TestMergeCommutativeAssociative merges three disjoint fixed datasets in
// different orders and groupings; the resulting state must be identical.
func TestMergeCommutativeAssociative(t *testing.T) {
	items := fixedItems(60000)
	mk := func(from, to int) *Sketch { return build(14, testSeed, items[from:to]) }

	merge := func(sketches ...*Sketch) *Sketch {
		acc := sketches[0].Clone()
		for _, s := range sketches[1:] {
			if err := acc.Merge(s); err != nil {
				t.Fatal(err)
			}
		}
		return acc
	}
	a, b, c := mk(0, 20000), mk(20000, 40000), mk(40000, 60000)

	abC := merge(a, b, c)
	aBC := merge(a, merge(b, c))
	bAC := merge(b, a, c)
	cBA := merge(c, b, a)

	for name, s := range map[string]*Sketch{"a(bc)": aBC, "(ba)c": bAC, "(cb)a": cBA} {
		if !abC.Equal(s) {
			t.Fatalf("merge order %s produced a different sketch", name)
		}
	}
	if est := abC.Estimate(); relErr(est, 60000) > 0.02 {
		t.Fatalf("merged estimate %d off by more than 2%%", est)
	}
}

// TestMergeMixedRepresentations merges a sparse sketch into a dense one.
func TestMergeMixedRepresentations(t *testing.T) {
	items := fixedItems(30000)
	dense := build(12, testSeed, items[:20000])
	if dense.IsSparse() {
		t.Fatal("expected dense")
	}
	sparse := build(12, testSeed, items[20000:20500])
	if !sparse.IsSparse() {
		t.Fatal("expected sparse")
	}
	if err := dense.Merge(sparse); err != nil {
		t.Fatal(err)
	}
	if est := dense.Estimate(); relErr(est, 20500) > 0.03 {
		t.Fatalf("mixed merge estimate %d off by more than 3%%", est)
	}
}

// TestReducePrecisionSparse verifies that re-encoding sparse values at a
// lower precision yields exactly the sketch built directly at that
// precision.
func TestReducePrecisionSparse(t *testing.T) {
	items := fixedItems(500)
	hi := build(16, testSeed, items)
	if !hi.IsSparse() {
		t.Fatal("expected sparse")
	}
	for _, p2 := range []uint8{8, 10, 12} {
		reduced, err := hi.ReducePrecision(p2)
		if err != nil {
			t.Fatal(err)
		}
		direct := build(p2, testSeed, items)
		if !reduced.Equal(direct) {
			t.Fatalf("p2=%d: sparse reduce differs from direct build", p2)
		}
	}
}

// TestSerializationRoundTrip checks that marshaling is stable: bytes are
// identical across calls and survive a round trip unchanged.
func TestSerializationRoundTrip(t *testing.T) {
	for _, n := range []int{50, 50000} { // sparse and dense variants
		s := build(14, testSeed, fixedItems(n))
		b1, err := s.MarshalBinary()
		if err != nil {
			t.Fatal(err)
		}
		b2, _ := s.MarshalBinary()
		if !bytes.Equal(b1, b2) {
			t.Fatalf("n=%d: marshal not deterministic", n)
		}
		var back Sketch
		if err := back.UnmarshalBinary(b1); err != nil {
			t.Fatal(err)
		}
		if !s.Equal(&back) {
			t.Fatalf("n=%d: round trip changed state", n)
		}
		b3, _ := back.MarshalBinary()
		if !bytes.Equal(b1, b3) {
			t.Fatalf("n=%d: re-marshal differs", n)
		}
		if back.Estimate() != s.Estimate() {
			t.Fatalf("n=%d: estimate changed after round trip", n)
		}
	}
}

func TestUnmarshalRejectsGarbage(t *testing.T) {
	var s Sketch
	for _, blob := range [][]byte{
		nil,
		[]byte("H1"),
		[]byte("XX\x01\x00\x0c\x00" + string(make([]byte, 8))),
	} {
		if err := s.UnmarshalBinary(blob); err == nil {
			t.Fatalf("expected error for %q", blob)
		}
	}
}

// TestSeedIsolation: same items under different seeds must not merge, and
// estimates from a second fixed seed stay within the error bound.
func TestSeedIsolation(t *testing.T) {
	const n = 50000
	items := fixedItems(n)
	s1 := build(14, testSeed, items)
	s2 := build(14, testSeed+1, items)
	if err := s1.Merge(s2); !errors.Is(err, ErrSeedMismatch) {
		t.Fatalf("expected ErrSeedMismatch, got %v", err)
	}
	if est := s2.Estimate(); relErr(est, n) > 0.02 {
		t.Fatalf("second seed estimate %d off by more than 2%%", est)
	}
}

// TestAddHashPreHashed ensures AddHash with the package hash matches Add.
func TestAddHashPreHashed(t *testing.T) {
	items := fixedItems(5000)
	a := build(12, testSeed, items)
	b, _ := New(12, testSeed)
	for _, it := range items {
		b.AddHash(hash64(it, testSeed))
	}
	if !a.Equal(b) {
		t.Fatal("Add and AddHash diverged")
	}
}

// TestHash64KnownVectors pins the hash implementation so serialized sketches
// remain comparable across versions.
func TestHash64KnownVectors(t *testing.T) {
	cases := []struct {
		in   string
		seed uint64
		want uint64
	}{
		{"", 0, 0xEF46DB3751D8E999},
		{"a", 0, 0xD24EC4F1A98C6E5B},
		{"hello", 42, 0xC3629E6318D53932},
	}
	for _, c := range cases {
		var buf [8]byte
		got := hash64([]byte(c.in), c.seed)
		binary.LittleEndian.PutUint64(buf[:], got)
		if got != c.want {
			t.Errorf("hash64(%q, %d) = %#x, want %#x", c.in, c.seed, got, c.want)
		}
	}
}
