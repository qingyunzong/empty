package dataeng

import (
	"math"
	"math/rand"
	"testing"
)

func TestHashIDMismatchRejected(t *testing.T) {
	hasher := testHasher(rand.New(rand.NewSource(1)))
	a := mustNew(t, 6, 64, hasher)
	b, err := New(Config{Precision: 6, HashID: "other", Hasher: hasher, SparseThreshold: 64})
	if err != nil {
		t.Fatal(err)
	}
	a.AddHash(1)
	b.AddHash(2)
	if err := a.Merge(b); err == nil {
		t.Fatal("Merge with different hash IDs must fail")
	}
	if _, err := Union(a, b); err == nil {
		t.Fatal("Union with different hash IDs must fail")
	}
}

func TestPrecisionCanOnlyDecrease(t *testing.T) {
	hasher := testHasher(rand.New(rand.NewSource(1)))
	low := mustNew(t, 4, 16, hasher)
	high := mustNew(t, 8, 256, hasher)
	high.AddHash(123)
	if _, err := high.Downcast(9); err == nil {
		t.Fatal("upward Downcast must fail")
	}
	if err := low.Merge(high); err != nil {
		t.Fatalf("higher precision merging into lower should downcast: %v", err)
	}
	if err := high.Merge(low); err == nil {
		t.Fatal("raising precision via Merge must fail")
	}

	same, err := high.Downcast(8)
	if err != nil {
		t.Fatal(err)
	}
	same.AddHash(456)
	if high.NonZeroCount() != 1 {
		t.Fatal("Downcast to equal precision must return an independent copy")
	}
}

func TestSparseDenseTransitionAndCanonicalSequence(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	const p = 6
	const threshold = 8
	hasher := testHasher(rand.New(rand.NewSource(4)))

	sparseSketch := mustNew(t, p, threshold, hasher)
	alwaysDense := mustNew(t, p, 1<<p, hasher)
	stream := make([]uint64, 60)
	for i := range stream {
		stream[i] = rng.Uint64()
	}
	for i, h := range stream {
		sparseSketch.AddHash(h)
		alwaysDense.AddHash(h)
		if i < threshold-1 && sparseSketch.IsDense() {
			t.Fatalf("converted dense at %d non-zero registers", i+1)
		}
	}
	if !sparseSketch.IsDense() {
		t.Fatal("sketch must have converted to dense at the threshold")
	}
	if !sameRegisters(sparseSketch.Registers(), alwaysDense.Registers()) {
		t.Fatal("sparse->dense representation changed canonical registers")
	}
	// Conversion is one-way: continued updates must keep working.
	before := sparseSketch.NonZeroCount()
	for i := 0; i < 200; i++ {
		sparseSketch.AddHash(rng.Uint64())
	}
	if !sparseSketch.IsDense() || sparseSketch.NonZeroCount() < before {
		t.Fatal("dense sketch did not keep accepting updates")
	}
}

func TestDowncastAndMergeHonorTargetThreshold(t *testing.T) {
	rng := rand.New(rand.NewSource(5))
	hasher := testHasher(rand.New(rand.NewSource(6)))
	stream := make([]uint64, 200)
	for i := range stream {
		stream[i] = rng.Uint64()
	}
	high := directSketch(t, 10, 16, hasher, stream)

	low, err := high.Downcast(6)
	if err != nil {
		t.Fatal(err)
	}
	if low.SparseThreshold() != 16 {
		t.Fatalf("downcast threshold = %d, want target threshold 16", low.SparseThreshold())
	}
	if !low.IsDense() {
		t.Fatal("downcast must follow target threshold and become dense")
	}

	target := mustNew(t, 6, 4, hasher)
	if err := target.Merge(high); err != nil {
		t.Fatal(err)
	}
	if !target.IsDense() {
		t.Fatal("merge must follow receiver threshold and become dense")
	}

	// Threshold clamps when the target has fewer registers than the source.
	tiny, err := high.Downcast(4)
	if err != nil {
		t.Fatal(err)
	}
	if tiny.SparseThreshold() != 16 {
		t.Fatalf("clamped threshold = %d, want 16", tiny.SparseThreshold())
	}
}

func TestEstimateFormulaAndRanges(t *testing.T) {
	// One occupied register leaves V > 0 and E small, so linear counting wins.
	s := mustNew(t, 4, 16, func([]byte) uint64 { return 0 })
	s.AddHash(hashWith(4, 0, uint64(1)<<(64-4-2)))
	m := 16
	want := float64(m) * math.Log(float64(m)/15.0)
	if got := s.Estimate(); math.Abs(got-want) > 1e-12 {
		t.Fatalf("linear estimate = %v, want %v", got, want)
	}

	// Fill every register so V == 0 forces the raw estimator.
	full := mustNew(t, 4, 16, func([]byte) uint64 { return 0 })
	sum := 0.0
	for idx := 0; idx < m; idx++ {
		rho := uint8(1 + idx%3)
		full.put(uint32(idx), rho)
		sum += math.Pow(2, -float64(rho))
	}
	want = 0.673 * float64(m) * float64(m) / sum
	if got := full.Estimate(); math.Abs(got-want) > 1e-12 {
		t.Fatalf("raw estimate = %v, want %v", got, want)
	}

	// Alpha table for the special m values and the general formula.
	for _, tc := range []struct {
		p    int
		want float64
	}{
		{4, 0.673}, {5, 0.697}, {6, 0.709},
		{7, 0.7213 / (1 + 1.079/128.0)},
	} {
		if got := alpha(1 << tc.p); math.Abs(got-tc.want) > 1e-15 {
			t.Fatalf("alpha(m=%d) = %v, want %v", 1<<tc.p, got, tc.want)
		}
	}
}

// TestEstimateSanityOnly does not prove correctness through one random
// error; exact register tests do that. This is a loose estimator band check.
func TestEstimateSanityOnly(t *testing.T) {
	rng := rand.New(rand.NewSource(8))
	hasher := testHasher(rand.New(rand.NewSource(9)))
	s := mustNew(t, 12, 1<<12, hasher)
	const cardinality = 50000
	seen := make(map[uint64]struct{}, cardinality)
	for len(seen) < cardinality {
		seen[rng.Uint64()] = struct{}{}
	}
	for h := range seen {
		s.AddHash(h)
	}
	got := s.Estimate()
	if math.Abs(got-cardinality) > 0.15*cardinality {
		t.Fatalf("estimate %v more than 15%% away from %d", got, cardinality)
	}
}

func TestPrecisionBoundariesAndThresholdOne(t *testing.T) {
	rng := rand.New(rand.NewSource(13))
	hasher := testHasher(rand.New(rand.NewSource(14)))

	// Threshold 1 forces dense representation on the first non-zero register.
	dense := mustNew(t, maxPrecision, 1, hasher)
	dense.AddHash(hashWith(maxPrecision, 0, 1))
	if dense.IsDense() {
		t.Fatal("threshold 1 converts only when the second distinct register arrives")
	}
	dense.AddHash(hashWith(maxPrecision, 1, 1))
	if !dense.IsDense() || len(dense.Registers()) != 1<<maxPrecision {
		t.Fatal("reaching threshold 1 must convert to a full dense array")
	}

	// Threshold equal to the register count keeps the sketch sparse forever
	// unless every register is occupied.
	sparse := mustNew(t, minPrecision, 1<<minPrecision, hasher)
	for i := 0; i < 1<<minPrecision-1; i++ {
		sparse.AddHash(hashWith(minPrecision, uint32(i), 1))
	}
	if sparse.IsDense() {
		t.Fatal("sketch below the full register count must stay sparse")
	}

	// Repeated identical updates never change the registers or counts.
	repeat := mustNew(t, 8, 256, hasher)
	h := rng.Uint64()
	for i := 0; i < 100; i++ {
		repeat.AddHash(h)
	}
	if repeat.NonZeroCount() != 1 {
		t.Fatalf("repeated hash produced %d registers, want 1", repeat.NonZeroCount())
	}
}

func TestFullRangeDowncastIsExact(t *testing.T) {
	rng := rand.New(rand.NewSource(15))
	hasher := testHasher(rand.New(rand.NewSource(16)))
	stream := make([]uint64, 1000)
	for i := range stream {
		stream[i] = rng.Uint64()
	}
	high := directSketch(t, maxPrecision, 1<<maxPrecision, hasher, stream)
	current := high
	for targetP := maxPrecision - 1; targetP >= minPrecision; targetP-- {
		direct := directSketch(t, targetP, 1<<targetP, hasher, stream)
		reduced, err := current.Downcast(targetP)
		if err != nil {
			t.Fatalf("Downcast(%d): %v", targetP, err)
		}
		if !sameRegisters(reduced.Registers(), direct.Registers()) {
			t.Fatalf("registers differ at precision %d", targetP)
		}
		current = reduced
	}
}

func TestMergeDoesNotMutateRepeatedSource(t *testing.T) {
	rng := rand.New(rand.NewSource(17))
	hasher := testHasher(rand.New(rand.NewSource(18)))
	source := mustNew(t, 7, 128, hasher)
	for i := 0; i < 40; i++ {
		source.AddHash(rng.Uint64())
	}
	before := source.Registers()

	target := mustNew(t, 5, 32, hasher)
	if err := target.Merge(source); err != nil {
		t.Fatal(err)
	}
	// Merging the same source twice must stay idempotent and non-mutating.
	if err := target.Merge(source); err != nil {
		t.Fatal(err)
	}
	if !sameRegisters(source.Registers(), before) {
		t.Fatal("source sketch was mutated by repeated merges")
	}
	sourceAtTarget, err := source.Downcast(5)
	if err != nil {
		t.Fatal(err)
	}
	if !sameRegisters(target.Registers(), sourceAtTarget.Registers()) {
		t.Fatal("merged registers must equal the downcast source")
	}

	again, err := Union(source, source, source)
	if err != nil {
		t.Fatal(err)
	}
	if !sameRegisters(source.Registers(), before) {
		t.Fatal("source sketch was mutated by a repeated-instance union")
	}
	if !sameRegisters(again.Registers(), source.Registers()) {
		t.Fatal("repeated union must keep the same canonical register sequence")
	}
}
