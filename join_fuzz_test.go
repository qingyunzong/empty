package dataeng

import (
	"math/big"
	"math/rand"
	"reflect"
	"testing"
)

// TestRandomBatchesAgainstFullExpansion drives both the incremental Join and
// the independent full-expansion reference through identical random batches,
// including retractions, duplicate rows, NULL/empty keys and same-batch
// updates on both sides.
func TestRandomBatchesAgainstFullExpansion(t *testing.T) {
	rng := rand.New(rand.NewSource(0x0071))

	ids := [][]byte{
		[]byte("l1"), []byte("l2"), []byte("l3"), []byte("l10"),
		[]byte("r1"), []byte("r2"), []byte("r3"), []byte("r10"),
	}
	leftIDs := ids[:4]
	rightIDs := ids[4:]

	keys := [][]byte{nil, {}, []byte("a"), []byte("ab"), []byte("b"), []byte("a")}

	j := NewJoin()
	reference := newReference()

	for iteration := 0; iteration < 400; iteration++ {
		batchSize := 1 + rng.Intn(8)
		changes := make([]Change, 0, batchSize)

		for n := 0; n < batchSize; n++ {
			side := Side(rng.Intn(2))

			var rowID []byte
			if side == Left {
				rowID = leftIDs[rng.Intn(len(leftIDs))]
			} else {
				rowID = rightIDs[rng.Intn(len(rightIDs))]
			}

			weight := big.NewInt(int64(rng.Intn(7)) - 3)
			changes = append(changes, Change{
				Side:   side,
				RowID:  rowID,
				Key:    keys[rng.Intn(len(keys))],
				Weight: weight,
			})
		}

		gotDeltas, gotErr := j.Apply(changes)
		wantDeltas, wantErr := reference.apply(changes)

		if gotErr != nil && wantErr == nil {
			t.Fatalf("iteration %d: incremental rejected a batch the reference accepted: %v\n%v",
				iteration, gotErr, changes)
		}
		if gotErr == nil && wantErr != nil {
			t.Fatalf("iteration %d: incremental accepted an invalid batch: %v",
				iteration, changes)
		}

		if gotErr != nil {
			// A rejected batch must be fully retried against the reference,
			// which also kept its old state; continue with a valid batch next.
			if !reflect.DeepEqual(deltaMap(gotDeltas), map[[2]string]*big.Int{}) {
				t.Fatalf("iteration %d: rejected batch returned deltas: %v",
					iteration, gotDeltas)
			}
			continue
		}

		if !reflect.DeepEqual(deltaMap(gotDeltas), wantDeltas) {
			t.Fatalf("iteration %d delta mismatch\n got %v\nwant %v\nbatch %v",
				iteration, deltaMap(gotDeltas), wantDeltas, changes)
		}
		assertOrder(t, gotDeltas)
		assertStateEqual(t, j, reference)

		// Explicitly verify every pair against the full expansion.
		full := expandJoin(reference.left, reference.right)
		for pair, wantWeight := range full {
			leftRow, leftOK := j.left[pair[0]]
			rightRow, rightOK := j.right[pair[1]]
			if !leftOK || !rightOK {
				t.Fatalf("iteration %d: pair %v missing from incremental state",
					iteration, pair)
			}
			gotWeight := new(big.Int).Mul(leftRow.weight, rightRow.weight)
			if gotWeight.Cmp(wantWeight) != 0 {
				t.Fatalf("iteration %d: pair %v full weight mismatch\n got %s\nwant %s",
					iteration, pair, gotWeight, wantWeight)
			}
		}
	}
}
