package dataeng

import (
	"math/rand"
	"testing"
)

const testHashID = "test-hash-v1"

func testHasher(rng *rand.Rand) Hasher {
	return func([]byte) uint64 { return rng.Uint64() }
}

func mustNew(t *testing.T, p, threshold int, hasher Hasher) *Sketch {
	t.Helper()
	s, err := New(Config{
		Precision:       p,
		HashID:          testHashID,
		Hasher:          hasher,
		SparseThreshold: threshold,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

// hashWith constructs a hash whose top p bits equal idx and whose low 64-p
// bits equal tail. tail must fit in 64-p bits.
func hashWith(p int, idx uint32, tail uint64) uint64 {
	return (uint64(idx) << (64 - p)) | tail
}

func TestConfigValidation(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	cases := []Config{
		{Precision: 3, HashID: testHashID, Hasher: testHasher(rng), SparseThreshold: 1},
		{Precision: 19, HashID: testHashID, Hasher: testHasher(rng), SparseThreshold: 1},
		{Precision: 6, HashID: testHashID, Hasher: testHasher(rng), SparseThreshold: 0},
		{Precision: 6, HashID: testHashID, Hasher: testHasher(rng), SparseThreshold: 65},
		{Precision: 6, HashID: testHashID, Hasher: nil, SparseThreshold: 4},
		{Precision: 6, HashID: "", Hasher: testHasher(rng), SparseThreshold: 4},
	}
	for _, cfg := range cases {
		if _, err := New(cfg); err == nil {
			t.Errorf("New(%+v) expected error", cfg)
		}
	}
}

func TestRankAndIndexFixtures(t *testing.T) {
	const p = 6
	maxRho := uint8(65 - p)

	// Discarded index bits all zero: hash lands at source offset 0.
	zeroDiscard := hashWith(p, 0b000100, 0)
	if got := registerIndex(zeroDiscard, p); got != 0b000100 {
		t.Fatalf("index = %d", got)
	}
	if got := rankAt(zeroDiscard, p); got != maxRho {
		t.Fatalf("all-zero suffix rho = %d, want %d", got, maxRho)
	}

	// Discarded index bits non-zero: suffix still all zero, so rho is max.
	nonZeroDiscard := hashWith(p, 0b000111, 0)
	if got := rankAt(nonZeroDiscard, p); got != maxRho {
		t.Fatalf("max rho with non-zero index = %d, want %d", got, maxRho)
	}

	// First set bit at the highest of the 64-p suffix positions: rho = 1.
	firstBit := hashWith(p, 0b000001, uint64(1)<<(64-p-1))
	if got := rankAt(firstBit, p); got != 1 {
		t.Fatalf("highest-set-bit rho = %d, want 1", got)
	}

	// A set bit k positions below the suffix top yields rho = k.
	middleBit := hashWith(p, 0b000010, uint64(1)<<(64-p-4))
	if got := rankAt(middleBit, p); got != 4 {
		t.Fatalf("middle rho = %d, want 4", got)
	}

	// Cross-precision ranks are checked with an independent bit-by-bit
	// reference so the fixture does not rely on shift arithmetic.
	h := hashWith(6, 0b000100, uint64(1)<<(64-8))
	for _, q := range []int{4, 5, 6, 10, 18} {
		if got := rankAt(h, q); got != naiveRank(h, q) {
			t.Fatalf("rankAt(_, %d) = %d, want %d", q, got, naiveRank(h, q))
		}
	}
	if got := rankAt(0, 6); got != 59 {
		t.Fatalf("rankAt(0, 6) = %d, want 59", got)
	}
}

// naiveRank scans bits explicitly from the (64-q)-th position downward.
func naiveRank(h uint64, q int) uint8 {
	for pos := 63 - q; pos >= 0; pos-- {
		if h&(uint64(1)<<pos) != 0 {
			return uint8(63 - q - pos + 1)
		}
	}
	return uint8(65 - q)
}

func TestUpdateIsIdempotentAndMaximal(t *testing.T) {
	s := mustNew(t, 6, 64, func([]byte) uint64 { return 0 })
	hHigh := hashWith(6, 7, uint64(1)<<(64-6-1))  // rho 1
	hLater := hashWith(6, 7, uint64(1)<<(64-6-3)) // rho 3
	for i := 0; i < 10; i++ {
		s.AddHash(hHigh)
	}
	s.AddHash(hLater)
	regs := s.Registers()
	if regs[7] != 3 {
		t.Fatalf("register = %d, want max rho 3", regs[7])
	}
	if s.NonZeroCount() != 1 {
		t.Fatalf("non-zero count = %d, want 1", s.NonZeroCount())
	}
	if s.IsDense() {
		t.Fatal("small sketch must stay sparse")
	}
}

func TestEmptyEstimateIsZero(t *testing.T) {
	s := mustNew(t, 4, 16, func([]byte) uint64 { return 0 })
	if got := s.Estimate(); got != 0 {
		t.Fatalf("empty estimate = %v, want 0", got)
	}
}

// TestDowncastFixtures uses hand-built hashes exercising discarded bits that
// are both all zero and non-zero, all-zero suffixes and maximal rho.
func TestDowncastFixtures(t *testing.T) {
	const fromP, toP = 6, 4
	hashes := []uint64{
		hashWith(fromP, 0b000111, uint64(1)<<(64-fromP-1)),  // idx 7: group 1, offset 3, rho 1
		hashWith(fromP, 0b000100, uint64(1)<<(64-fromP-50)), // idx 4: group 1, offset 0, rho 50
		hashWith(fromP, 0b101001, uint64(1)<<(64-fromP-2)),  // idx 41: group 10, offset 1
		hashWith(fromP, 0b101000, uint64(1)<<(64-fromP-6)),  // idx 40: group 10, offset 0
	}

	high := mustNew(t, fromP, 1<<fromP, func([]byte) uint64 { return 0 })
	direct := mustNew(t, toP, 1<<toP, func([]byte) uint64 { return 0 })
	for _, h := range hashes {
		high.AddHash(h)
		direct.AddHash(h)
	}

	reduced, err := high.Downcast(toP)
	if err != nil {
		t.Fatalf("Downcast: %v", err)
	}
	got := reduced.Registers()
	want := direct.Registers()
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("register %d after downcast = %d, want %d; full %v", i, got[i], want[i], got)
		}
	}

	// The offset-0 hash keeps its all-zero discarded bits and dominates at
	// rank 52; the non-zero offset entry contributes rank 1. A naive max of
	// the source rho values (50 vs 1) would wrongly record 50, while the exact
	// low-precision register is 52.
	if got[1] != 52 || got[1] != naiveRank(hashes[1], toP) {
		t.Fatalf("group 1 register = %d, want %d", got[1], naiveRank(hashes[1], toP))
	}
	// Group 10 keeps the offset-0 all-zero-discard contribution.
	if got[10] != naiveRank(hashes[3], toP) {
		t.Fatalf("group 10 register = %d, want %d", got[10], naiveRank(hashes[3], toP))
	}
}

func directSketch(t *testing.T, p, threshold int, hasher Hasher, hashes []uint64) *Sketch {
	t.Helper()
	s := mustNew(t, p, threshold, hasher)
	for _, h := range hashes {
		s.AddHash(h)
	}
	return s
}

func sameRegisters(a, b []uint8) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
