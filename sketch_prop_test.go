package dataeng

import (
	"math/rand"
	"testing"
)

// TestDowncastExactAcrossPrecisions compares register-by-register against a
// sketch built directly at every lower precision, over many random streams;
// correctness is decided by exact register equality, never estimate error.
func TestDowncastExactAcrossPrecisions(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	hasher := testHasher(rand.New(rand.NewSource(99)))
	for iter := 0; iter < 40; iter++ {
		fromP := minPrecision + rng.Intn(maxPrecision-minPrecision+1)
		stream := make([]uint64, 1+rng.Intn(400))
		for i := range stream {
			stream[i] = rng.Uint64()
		}
		high := directSketch(t, fromP, 1<<fromP, hasher, stream)

		// Repeated stepwise downcasts across the full supported range.
		current := high
		for targetP := fromP - 1; targetP >= minPrecision; targetP-- {
			direct := directSketch(t, targetP, 1<<targetP, hasher, stream)
			reduced, err := current.Downcast(targetP)
			if err != nil {
				t.Fatalf("Downcast(%d): %v", targetP, err)
			}
			if !sameRegisters(reduced.Registers(), direct.Registers()) {
				t.Fatalf("iter %d p %d->%d: registers differ", iter, current.p, targetP)
			}
			current = reduced
		}

		// A single big jump must also be exact.
		direct := directSketch(t, minPrecision, 1<<minPrecision, hasher, stream)
		jump, err := high.Downcast(minPrecision)
		if err != nil {
			t.Fatalf("Downcast jump: %v", err)
		}
		if !sameRegisters(jump.Registers(), direct.Registers()) {
			t.Fatalf("iter %d: direct jump registers differ", iter)
		}
	}
}

func snapshotAll(sketches []*Sketch) map[*Sketch][]uint8 {
	out := make(map[*Sketch][]uint8, len(sketches))
	for _, sk := range sketches {
		out[sk] = sk.Registers()
	}
	return out
}

func assertSnapshots(t *testing.T, sketches []*Sketch, snapshots map[*Sketch][]uint8) {
	t.Helper()
	for _, sk := range sketches {
		if !sameRegisters(sk.Registers(), snapshots[sk]) {
			t.Fatalf("source sketch at precision %d was modified by merge", sk.Precision())
		}
	}
}

// TestMixedPrecisionMergeExhaustive reaches one direct low-p reference
// through shuffled, multi-level, mixed-precision merges and repeated
// downcasts. Register arrays must match exactly.
func TestMixedPrecisionMergeExhaustive(t *testing.T) {
	rng := rand.New(rand.NewSource(424242))
	hasher := testHasher(rand.New(rand.NewSource(7)))

	for iter := 0; iter < 30; iter++ {
		lowP := minPrecision + rng.Intn(4)
		highP := lowP + 1 + rng.Intn(maxPrecision-lowP)
		shards := 2 + rng.Intn(5)

		var allHashes []uint64
		shardHashes := make([][]uint64, shards)
		shardPrecision := make([]int, shards)
		for i := 0; i < shards; i++ {
			n := rng.Intn(120)
			shardPrecision[i] = lowP + rng.Intn(highP-lowP+1)
			for j := 0; j < n; j++ {
				h := rng.Uint64()
				shardHashes[i] = append(shardHashes[i], h)
				allHashes = append(allHashes, h)
			}
		}
		// Guarantee the minimum precision really occurs so Union must
		// reduce to it.
		shardPrecision[0] = lowP

		reference := directSketch(t, lowP, 1<<lowP, hasher, allHashes)

		var sketches []*Sketch
		for i := 0; i < shards; i++ {
			sketches = append(sketches, directSketch(t, shardPrecision[i], 1<<shardPrecision[i], hasher, shardHashes[i]))
		}
		rng.Shuffle(len(sketches), func(i, j int) { sketches[i], sketches[j] = sketches[j], sketches[i] })

		snapshots := snapshotAll(sketches)
		merged, err := Union(sketches...)
		if err != nil {
			t.Fatalf("Union: %v", err)
		}
		if merged.Precision() != lowP {
			t.Fatalf("union precision = %d, want min %d", merged.Precision(), lowP)
		}
		if !sameRegisters(merged.Registers(), reference.Registers()) {
			t.Fatalf("iter %d: union registers differ from direct build", iter)
		}

		// Receiver-side Merge across precision must also be exact and leave
		// every source untouched.
		target := mustNew(t, lowP, 1<<lowP, hasher)
		for _, sk := range sketches {
			if err := target.Merge(sk); err != nil {
				t.Fatalf("Merge: %v", err)
			}
		}
		if !sameRegisters(target.Registers(), reference.Registers()) {
			t.Fatalf("iter %d: merge registers differ", iter)
		}
		assertSnapshots(t, sketches, snapshots)

		// Nested unions at differing precision, shuffled again.
		rng.Shuffle(len(sketches), func(i, j int) { sketches[i], sketches[j] = sketches[j], sketches[i] })
		mid := len(sketches) / 2
		left, err := Union(sketches[:mid]...)
		if err != nil {
			t.Fatal(err)
		}
		right, err := Union(sketches[mid:]...)
		if err != nil {
			t.Fatal(err)
		}
		nested, err := Union(left, right)
		if err != nil {
			t.Fatal(err)
		}
		if !sameRegisters(nested.Registers(), reference.Registers()) {
			t.Fatalf("iter %d: nested union registers differ", iter)
		}
		assertSnapshots(t, sketches, snapshots)
	}
}
