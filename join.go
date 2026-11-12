// Package dataeng implements an incremental multiset equi-join for a
// streaming query host.
//
// The host maintains two multisets of rows, one per join side. Every row
// carries a row identifier, a (possibly NULL) join key and a signed integer
// weight. Rows with identical content on one side collapse into one entry
// whose weight is the sum of the constituent weights; a weight therefore
// represents the multiplicity of the row.
//
// Changes are applied in batches. A batch is validated atomically:
//
//   - all changes for the same (side, row ID) inside the batch must name the
//     same key, and that key must equal the key currently stored for that row
//     while the row still exists;
//   - the cumulative weight of every (side, row ID) after the batch must be
//     non-negative.
//
// When any check fails the batch is rejected and the join keeps its previous
// state unchanged.
//
// NULL keys never match anything, including other NULL keys. Non-NULL keys
// match when their raw bytes are equal, so an empty non-NULL key only matches
// other empty non-NULL keys.
//
// For each left/right row pair whose keys match, the join weight is the
// product of the two row weights. Apply returns the signed change of every
// pair weight, including the cross terms of rows that change on both sides
// inside the same batch. Only non-zero increments are returned, ordered by
// left row ID and then right row ID in byte order. All arithmetic uses
// math/big so arbitrary integer sizes never overflow.
package dataeng

import (
	"bytes"
	"errors"
	"math/big"
	"sort"
)

// Side selects the left or right join input.
type Side int

const (
	// Left is the left join input.
	Left Side = iota
	// Right is the right join input.
	Right
)

var (
	// ErrInvalidSide is returned when a change names neither Left nor Right.
	ErrInvalidSide = errors.New("dataeng: invalid join side")
	// ErrNilWeight is returned when a change has a nil weight.
	ErrNilWeight = errors.New("dataeng: change weight must not be nil")
	// ErrInconsistentRow is returned when changes for one (side, row ID)
	// declare different keys, or when a change's key differs from the key of
	// an existing row that has not been fully retracted.
	ErrInconsistentRow = errors.New("dataeng: inconsistent row content for row ID")
	// ErrNegativeWeight is returned when a batch would leave a row with a
	// negative cumulative weight.
	ErrNegativeWeight = errors.New("dataeng: row weight would become negative")
)

// Change is one signed weight adjustment for a row on one join side.
//
// A nil Key denotes the NULL key. Weight is added to the row's current
// weight and may itself be negative, as long as the batch end weight stays
// non-negative.
type Change struct {
	Side   Side
	RowID  []byte
	Key    []byte
	Weight *big.Int
}

// Delta is the change of one joined pair's weight after applying a batch.
type Delta struct {
	LeftRowID  []byte
	RightRowID []byte
	Weight     *big.Int
}

type row struct {
	key    []byte
	isNull bool
	weight *big.Int
}

type batchRow struct {
	key     []byte
	isNull  bool
	delta   *big.Int
	touched bool
}

// Join holds the accumulated multiset state of both join inputs.
//
// A Join is not safe for concurrent use; callers sharing one across
// goroutines must provide their own synchronization.
type Join struct {
	left       map[string]*row
	right      map[string]*row
	leftIndex  map[string]map[string]struct{}
	rightIndex map[string]map[string]struct{}
}

// NewJoin returns an empty join.
func NewJoin() *Join {
	return &Join{
		left:       map[string]*row{},
		right:      map[string]*row{},
		leftIndex:  map[string]map[string]struct{}{},
		rightIndex: map[string]map[string]struct{}{},
	}
}

// Apply validates and applies one batch of changes and returns the non-zero
// joined-pair weight increments in left/right row ID byte order.
//
// The returned error is non-nil when validation fails; in that case the
// Join state is untouched and the returned slice is empty.
func (j *Join) Apply(changes []Change) ([]Delta, error) {
	leftBatch := map[string]*batchRow{}
	rightBatch := map[string]*batchRow{}

	for _, change := range changes {
		if change.Weight == nil {
			return nil, ErrNilWeight
		}

		var state map[string]*row
		var batch map[string]*batchRow

		switch change.Side {
		case Left:
			state, batch = j.left, leftBatch
		case Right:
			state, batch = j.right, rightBatch
		default:
			return nil, ErrInvalidSide
		}

		id := string(change.RowID)

		agg, ok := batch[id]
		if !ok {
			agg = &batchRow{delta: new(big.Int)}
			batch[id] = agg
			if existing, exists := state[id]; exists {
				agg.key = existing.key
				agg.isNull = existing.isNull
			} else {
				agg.key = cloneBytes(change.Key)
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

	newLeft := make(map[string]*row, len(j.left)+len(leftBatch))
	for id, rowState := range j.left {
		newLeft[id] = &row{
			key:    rowState.key,
			isNull: rowState.isNull,
			weight: new(big.Int).Set(rowState.weight),
		}
	}

	newRight := make(map[string]*row, len(j.right)+len(rightBatch))
	for id, rowState := range j.right {
		newRight[id] = &row{
			key:    rowState.key,
			isNull: rowState.isNull,
			weight: new(big.Int).Set(rowState.weight),
		}
	}

	if err := applySide(leftBatch, newLeft); err != nil {
		return nil, err
	}
	if err := applySide(rightBatch, newRight); err != nil {
		return nil, err
	}

	type pair struct {
		leftID  string
		rightID string
	}

	affected := map[pair]struct{}{}

	for leftID, agg := range leftBatch {
		if agg.isNull {
			continue
		}
		key := string(agg.key)

		for rightID := range j.rightIndex[key] {
			affected[pair{leftID: leftID, rightID: rightID}] = struct{}{}
		}
		for rightID := range rightBatch {
			if other, ok := rightBatch[rightID]; ok && !other.isNull &&
				string(other.key) == key {
				affected[pair{leftID: leftID, rightID: rightID}] = struct{}{}
			}
		}
	}

	for rightID, agg := range rightBatch {
		if agg.isNull {
			continue
		}
		key := string(agg.key)

		for leftID := range j.leftIndex[key] {
			affected[pair{leftID: leftID, rightID: rightID}] = struct{}{}
		}
	}

	deltas := make([]Delta, 0, len(affected))

	for p := range affected {
		var oldWeight, newWeight *big.Int

		oldLeft, leftExists := j.left[p.leftID]
		oldRight, rightExists := j.right[p.rightID]
		if leftExists && rightExists &&
			!oldLeft.isNull && !oldRight.isNull &&
			bytes.Equal(oldLeft.key, oldRight.key) {
			oldWeight = new(big.Int).Mul(oldLeft.weight, oldRight.weight)
		} else {
			oldWeight = new(big.Int)
		}

		newLeft, leftExists := newLeft[p.leftID]
		newRight, rightExists := newRight[p.rightID]
		if leftExists && rightExists &&
			!newLeft.isNull && !newRight.isNull &&
			bytes.Equal(newLeft.key, newRight.key) {
			newWeight = new(big.Int).Mul(newLeft.weight, newRight.weight)
		} else {
			newWeight = new(big.Int)
		}

		increment := new(big.Int).Sub(newWeight, oldWeight)
		if increment.Sign() == 0 {
			continue
		}

		deltas = append(deltas, Delta{
			LeftRowID:  []byte(p.leftID),
			RightRowID: []byte(p.rightID),
			Weight:     increment,
		})
	}

	sort.Slice(deltas, func(i, k int) bool {
		if cmp := bytes.Compare(deltas[i].LeftRowID, deltas[k].LeftRowID); cmp != 0 {
			return cmp < 0
		}
		return bytes.Compare(deltas[i].RightRowID, deltas[k].RightRowID) < 0
	})

	j.left = newLeft
	j.right = newRight
	j.leftIndex = rebuildIndex(newLeft)
	j.rightIndex = rebuildIndex(newRight)

	return deltas, nil
}

func applySide(batch map[string]*batchRow, state map[string]*row) error {
	for id, agg := range batch {
		current := new(big.Int)
		if existing, ok := state[id]; ok {
			current.Set(existing.weight)
		}

		next := current.Add(current, agg.delta)
		if next.Sign() < 0 {
			return ErrNegativeWeight
		}

		if next.Sign() == 0 {
			delete(state, id)
			continue
		}

		state[id] = &row{
			key:    agg.key,
			isNull: agg.isNull,
			weight: new(big.Int).Set(next),
		}
	}

	return nil
}

func sameKey(leftNull bool, leftKey []byte, rightNull bool, rightKey []byte) bool {
	if leftNull || rightNull {
		return leftNull && rightNull
	}
	return bytes.Equal(leftKey, rightKey)
}

func cloneBytes(value []byte) []byte {
	if value == nil {
		return nil
	}
	return append([]byte(nil), value...)
}

func rebuildIndex(state map[string]*row) map[string]map[string]struct{} {
	index := make(map[string]map[string]struct{}, len(state))

	for id, rowState := range state {
		if rowState.isNull {
			continue
		}

		key := string(rowState.key)
		ids, ok := index[key]
		if !ok {
			ids = map[string]struct{}{}
			index[key] = ids
		}
		ids[id] = struct{}{}
	}

	return index
}
