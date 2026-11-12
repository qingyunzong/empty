package dataeng

import (
	"math/big"
	"reflect"
	"testing"
)

func TestApplyLifecycleAndRetractions(t *testing.T) {
	j := NewJoin()
	r := newReference()

	batches := [][]Change{
		{
			{Side: Left, RowID: []byte("l1"), Key: []byte("k"), Weight: big.NewInt(3)},
			{Side: Left, RowID: []byte("l2"), Key: []byte("k"), Weight: big.NewInt(2)},
			{Side: Right, RowID: []byte("r1"), Key: []byte("k"), Weight: big.NewInt(4)},
			{Side: Right, RowID: []byte("r2"), Key: []byte("other"), Weight: big.NewInt(9)},
		},
		{
			{Side: Left, RowID: []byte("l1"), Key: []byte("k"), Weight: big.NewInt(-2)},
			{Side: Right, RowID: []byte("r1"), Key: []byte("k"), Weight: big.NewInt(-1)},
		},
		{
			{Side: Right, RowID: []byte("r1"), Key: []byte("k"), Weight: big.NewInt(-3)},
		},
		{
			{Side: Left, RowID: []byte("l2"), Key: []byte("k"), Weight: big.NewInt(-2)},
		},
		{
			{Side: Left, RowID: []byte("l1"), Key: []byte("k"), Weight: big.NewInt(7)},
			{Side: Right, RowID: []byte("r1"), Key: []byte("k"), Weight: big.NewInt(5)},
		},
		{
			{Side: Left, RowID: []byte("l1"), Key: []byte("k"), Weight: big.NewInt(-8)},
		},
	}

	for i, batch := range batches {
		gotDeltas, gotErr := j.Apply(batch)
		wantDeltas, wantErr := r.apply(batch)

		if gotErr != wantErr {
			t.Fatalf("batch %d error mismatch\n got %v\nwant %v", i, gotErr, wantErr)
		}
		if !reflect.DeepEqual(deltaMap(gotDeltas), wantDeltas) {
			t.Fatalf("batch %d delta mismatch\n got %v\nwant %v",
				i, deltaMap(gotDeltas), wantDeltas)
		}
		assertOrder(t, gotDeltas)
		assertStateEqual(t, j, r)
	}
}

func TestRetractThenReintroduceWithDifferentKey(t *testing.T) {
	j := NewJoin()
	r := newReference()

	batches := [][]Change{
		{
			{Side: Left, RowID: []byte("l1"), Key: []byte("a"), Weight: big.NewInt(2)},
			{Side: Right, RowID: []byte("r1"), Key: []byte("a"), Weight: big.NewInt(3)},
		},
		{
			{Side: Left, RowID: []byte("l1"), Key: []byte("a"), Weight: big.NewInt(-2)},
		},
		{
			{Side: Left, RowID: []byte("l1"), Key: []byte("b"), Weight: big.NewInt(4)},
			{Side: Right, RowID: []byte("r2"), Key: []byte("b"), Weight: big.NewInt(5)},
		},
	}

	for i, batch := range batches {
		gotDeltas, gotErr := j.Apply(batch)
		wantDeltas, wantErr := r.apply(batch)

		if gotErr != wantErr {
			t.Fatalf("batch %d error mismatch\n got %v\nwant %v", i, gotErr, wantErr)
		}
		if !reflect.DeepEqual(deltaMap(gotDeltas), wantDeltas) {
			t.Fatalf("batch %d delta mismatch\n got %v\nwant %v",
				i, deltaMap(gotDeltas), wantDeltas)
		}
		assertOrder(t, gotDeltas)
		assertStateEqual(t, j, r)
	}

	finalJoin := expandJoin(r.left, r.right)
	if got := finalJoin[[2]string{"l1", "r2"}]; got == nil || got.Cmp(big.NewInt(20)) != 0 {
		t.Fatalf("final join weight mismatch\n got %v\nwant 20", got)
	}
	if _, ok := finalJoin[[2]string{"l1", "r1"}]; ok {
		t.Fatal("retracted pair must no longer participate in the join")
	}
}

func TestFailedBatchLeavesStateUntouched(t *testing.T) {
	seed := []Change{
		{Side: Left, RowID: []byte("l1"), Key: []byte("k"), Weight: big.NewInt(2)},
		{Side: Right, RowID: []byte("r1"), Key: []byte("k"), Weight: big.NewInt(3)},
	}

	tests := []struct {
		name    string
		changes []Change
		wantErr error
	}{
		{
			name: "negative end weight",
			changes: []Change{
				{Side: Left, RowID: []byte("l1"), Key: []byte("k"), Weight: big.NewInt(-3)},
			},
			wantErr: ErrNegativeWeight,
		},
		{
			name: "inconsistent key inside batch",
			changes: []Change{
				{Side: Left, RowID: []byte("l9"), Key: []byte("a"), Weight: big.NewInt(1)},
				{Side: Left, RowID: []byte("l9"), Key: []byte("b"), Weight: big.NewInt(1)},
			},
			wantErr: ErrInconsistentRow,
		},
		{
			name: "key differs from existing row",
			changes: []Change{
				{Side: Left, RowID: []byte("l1"), Key: []byte("other"), Weight: big.NewInt(1)},
			},
			wantErr: ErrInconsistentRow,
		},
		{
			name: "nil weight",
			changes: []Change{
				{Side: Left, RowID: []byte("l9"), Key: []byte("a"), Weight: nil},
			},
			wantErr: ErrNilWeight,
		},
		{
			name: "invalid side",
			changes: []Change{
				{Side: Side(9), RowID: []byte("x"), Key: []byte("a"), Weight: big.NewInt(1)},
			},
			wantErr: ErrInvalidSide,
		},
		{
			name: "late failure still atomic",
			changes: []Change{
				{Side: Right, RowID: []byte("r9"), Key: []byte("k"), Weight: big.NewInt(7)},
				{Side: Right, RowID: []byte("r1"), Key: []byte("k"), Weight: big.NewInt(-4)},
			},
			wantErr: ErrNegativeWeight,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			j := NewJoin()
			r := newReference()

			if _, err := j.Apply(seed); err != nil {
				t.Fatalf("seed failed: %v", err)
			}
			if _, err := r.apply(seed); err != nil {
				t.Fatalf("reference seed failed: %v", err)
			}

			// Snapshot the internal maps so the failure assertion does not
			// depend on later helper semantics.
			beforeLeft := cloneRefSide(refFromRows(j.left))
			beforeRight := cloneRefSide(refFromRows(j.right))

			deltas, err := j.Apply(test.changes)
			if err != test.wantErr {
				t.Fatalf("error mismatch\n got %v\nwant %v", err, test.wantErr)
			}
			if len(deltas) != 0 {
				t.Fatalf("failed batch must return no deltas, got %v", deltas)
			}

			if !reflect.DeepEqual(refFromRows(j.left), beforeLeft) ||
				!reflect.DeepEqual(refFromRows(j.right), beforeRight) {
				t.Fatal("failed batch mutated join state")
			}
			assertStateEqual(t, j, r)
		})
	}
}

func refFromRows(state map[string]*row) map[string]*refRow {
	result := make(map[string]*refRow, len(state))
	for id, rowState := range state {
		result[id] = &refRow{
			key:    rowState.key,
			isNull: rowState.isNull,
			weight: new(big.Int).Set(rowState.weight),
		}
	}
	return result
}
