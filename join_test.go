package dataeng

import (
	"bytes"
	"math/big"
	"sort"
	"testing"
)

type refRow struct {
	key    []byte
	isNull bool
	weight *big.Int
}

type refAgg struct {
	key    []byte
	isNull bool
	delta  *big.Int
}

// referenceJoin keeps the same state but computes every batch result by fully
// expanding the join, independent of the incremental index logic.
type referenceJoin struct {
	left  map[string]*refRow
	right map[string]*refRow
}

func newReference() *referenceJoin {
	return &referenceJoin{
		left:  map[string]*refRow{},
		right: map[string]*refRow{},
	}
}

func (r *referenceJoin) apply(changes []Change) (map[[2]string]*big.Int, error) {
	leftBatch := map[string]*refAgg{}
	rightBatch := map[string]*refAgg{}

	for _, change := range changes {
		if change.Weight == nil {
			return nil, ErrNilWeight
		}

		var state map[string]*refRow
		var batch map[string]*refAgg

		switch change.Side {
		case Left:
			state, batch = r.left, leftBatch
		case Right:
			state, batch = r.right, rightBatch
		default:
			return nil, ErrInvalidSide
		}

		id := string(change.RowID)

		agg, ok := batch[id]
		if !ok {
			agg = &refAgg{delta: new(big.Int)}
			batch[id] = agg
			if existing, exists := state[id]; exists {
				agg.key = existing.key
				agg.isNull = existing.isNull
			} else {
				agg.key = change.Key
				agg.isNull = change.Key == nil
			}
		} else if !sameKey(agg.isNull, agg.key, change.Key == nil, change.Key) {
			return nil, ErrInconsistentRow
		}

		if existing, exists := state[id]; exists &&
			!sameKey(existing.isNull, existing.key, change.Key == nil, change.Key) {
			return nil, ErrInconsistentRow
		}

		agg.delta.Add(agg.delta, change.Weight)
	}

	newLeft := cloneRefSide(r.left)
	newRight := cloneRefSide(r.right)

	if err := applyRefBatch(leftBatch, newLeft); err != nil {
		return nil, err
	}
	if err := applyRefBatch(rightBatch, newRight); err != nil {
		return nil, err
	}

	oldJoin := expandJoin(r.left, r.right)
	newJoin := expandJoin(newLeft, newRight)

	all := map[[2]string]struct{}{}
	for pair := range oldJoin {
		all[pair] = struct{}{}
	}
	for pair := range newJoin {
		all[pair] = struct{}{}
	}

	deltas := map[[2]string]*big.Int{}
	for pair := range all {
		oldWeight := intOrZero(oldJoin[pair])
		newWeight := intOrZero(newJoin[pair])
		diff := new(big.Int).Sub(newWeight, oldWeight)
		if diff.Sign() != 0 {
			deltas[pair] = diff
		}
	}

	r.left = newLeft
	r.right = newRight

	return deltas, nil
}

func applyRefBatch(batch map[string]*refAgg, state map[string]*refRow) error {
	for id, agg := range batch {
		next := new(big.Int).Set(agg.delta)
		if existing, ok := state[id]; ok {
			next.Add(next, existing.weight)
		}
		if next.Sign() < 0 {
			return ErrNegativeWeight
		}
		if next.Sign() == 0 {
			delete(state, id)
			continue
		}
		state[id] = &refRow{
			key:    agg.key,
			isNull: agg.isNull,
			weight: next,
		}
	}
	return nil
}

func cloneRefSide(state map[string]*refRow) map[string]*refRow {
	copyState := make(map[string]*refRow, len(state))
	for id, rowState := range state {
		copyState[id] = &refRow{
			key:    rowState.key,
			isNull: rowState.isNull,
			weight: new(big.Int).Set(rowState.weight),
		}
	}
	return copyState
}

func intOrZero(value *big.Int) *big.Int {
	if value == nil {
		return new(big.Int)
	}
	return value
}

func expandJoin(left, right map[string]*refRow) map[[2]string]*big.Int {
	result := map[[2]string]*big.Int{}

	for leftID, leftRow := range left {
		if leftRow.isNull {
			continue
		}
		for rightID, rightRow := range right {
			if rightRow.isNull || !bytes.Equal(leftRow.key, rightRow.key) {
				continue
			}
			result[[2]string{leftID, rightID}] =
				new(big.Int).Mul(leftRow.weight, rightRow.weight)
		}
	}

	return result
}

func deltaMap(deltas []Delta) map[[2]string]*big.Int {
	result := make(map[[2]string]*big.Int, len(deltas))
	for _, delta := range deltas {
		result[[2]string{string(delta.LeftRowID), string(delta.RightRowID)}] =
			new(big.Int).Set(delta.Weight)
	}
	return result
}

func assertOrder(t *testing.T, deltas []Delta) {
	t.Helper()

	keys := make([][2]string, len(deltas))
	for i, delta := range deltas {
		keys[i] = [2]string{string(delta.LeftRowID), string(delta.RightRowID)}
	}

	if !sort.SliceIsSorted(keys, func(i, k int) bool {
		if keys[i][0] != keys[k][0] {
			return keys[i][0] < keys[k][0]
		}
		return keys[i][1] < keys[k][1]
	}) {
		t.Fatalf("deltas not in left/right row ID byte order: %v", keys)
	}
}

func rowsEqual(got map[string]*row, want map[string]*refRow) bool {
	if len(got) != len(want) {
		return false
	}

	for id, gotRow := range got {
		wantRow, ok := want[id]
		if !ok {
			return false
		}
		if gotRow.isNull != wantRow.isNull ||
			!bytes.Equal(gotRow.key, wantRow.key) ||
			gotRow.weight.Cmp(wantRow.weight) != 0 {
			return false
		}
	}

	return true
}

func assertStateEqual(t *testing.T, j *Join, r *referenceJoin) {
	t.Helper()

	if !rowsEqual(j.left, r.left) {
		t.Fatalf("left state mismatch\n got %v\nwant %v", j.left, r.left)
	}
	if !rowsEqual(j.right, r.right) {
		t.Fatalf("right state mismatch\n got %v\nwant %v", j.right, r.right)
	}
}
