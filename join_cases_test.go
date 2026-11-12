package dataeng

import (
	"math/big"
	"reflect"
	"testing"
)

func TestApplyDeterministicScenarios(t *testing.T) {
	tests := []struct {
		name    string
		changes []Change
		want    map[[2]string]int64
	}{
		{
			name: "basic insertion both sides",
			changes: []Change{
				{Side: Left, RowID: []byte("l1"), Key: []byte("k"), Weight: big.NewInt(1)},
				{Side: Right, RowID: []byte("r1"), Key: []byte("k"), Weight: big.NewInt(1)},
			},
			want: map[[2]string]int64{{"l1", "r1"}: 1},
		},
		{
			name: "duplicate rows accumulate multiplicities",
			changes: []Change{
				{Side: Left, RowID: []byte("l1"), Key: []byte("k"), Weight: big.NewInt(2)},
				{Side: Left, RowID: []byte("l1"), Key: []byte("k"), Weight: big.NewInt(3)},
				{Side: Right, RowID: []byte("r1"), Key: []byte("k"), Weight: big.NewInt(4)},
			},
			want: map[[2]string]int64{{"l1", "r1"}: 20},
		},
		{
			name: "cross terms of same batch both-side changes",
			changes: []Change{
				{Side: Left, RowID: []byte("l1"), Key: []byte("k"), Weight: big.NewInt(3)},
				{Side: Right, RowID: []byte("r1"), Key: []byte("k"), Weight: big.NewInt(5)},
			},
			want: map[[2]string]int64{{"l1", "r1"}: 15},
		},
		{
			name: "null key never matches null or anything",
			changes: []Change{
				{Side: Left, RowID: []byte("l1"), Key: nil, Weight: big.NewInt(2)},
				{Side: Right, RowID: []byte("r1"), Key: nil, Weight: big.NewInt(2)},
				{Side: Right, RowID: []byte("r2"), Key: []byte("k"), Weight: big.NewInt(2)},
			},
			want: map[[2]string]int64{},
		},
		{
			name: "empty non-null key only matches empty key",
			changes: []Change{
				{Side: Left, RowID: []byte("l1"), Key: []byte(""), Weight: big.NewInt(2)},
				{Side: Left, RowID: []byte("l2"), Key: []byte("x"), Weight: big.NewInt(2)},
				{Side: Right, RowID: []byte("r1"), Key: []byte(""), Weight: big.NewInt(3)},
			},
			want: map[[2]string]int64{{"l1", "r1"}: 6},
		},
		{
			name: "raw byte key equality distinguishes keys",
			changes: []Change{
				{Side: Left, RowID: []byte("l1"), Key: []byte("a"), Weight: big.NewInt(1)},
				{Side: Left, RowID: []byte("l2"), Key: []byte("ab"), Weight: big.NewInt(1)},
				{Side: Right, RowID: []byte("r1"), Key: []byte("a"), Weight: big.NewInt(1)},
				{Side: Right, RowID: []byte("r2"), Key: []byte("ab"), Weight: big.NewInt(1)},
			},
			want: map[[2]string]int64{
				{"l1", "r1"}: 1,
				{"l2", "r2"}: 1,
			},
		},
		{
			name: "deltas ordered by left then right row ID bytes",
			changes: []Change{
				{Side: Left, RowID: []byte("l2"), Key: []byte("k"), Weight: big.NewInt(1)},
				{Side: Left, RowID: []byte("l10"), Key: []byte("k"), Weight: big.NewInt(1)},
				{Side: Left, RowID: []byte("l1"), Key: []byte("k"), Weight: big.NewInt(1)},
				{Side: Right, RowID: []byte("r2"), Key: []byte("k"), Weight: big.NewInt(1)},
				{Side: Right, RowID: []byte("r10"), Key: []byte("k"), Weight: big.NewInt(1)},
				{Side: Right, RowID: []byte("r1"), Key: []byte("k"), Weight: big.NewInt(1)},
			},
			want: map[[2]string]int64{
				{"l1", "r1"}:   1,
				{"l1", "r10"}:  1,
				{"l1", "r2"}:   1,
				{"l10", "r1"}:  1,
				{"l10", "r10"}: 1,
				{"l10", "r2"}:  1,
				{"l2", "r1"}:   1,
				{"l2", "r10"}:  1,
				{"l2", "r2"}:   1,
			},
		},
		{
			name: "empty batch reports nothing",
			want: map[[2]string]int64{},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			j := NewJoin()
			r := newReference()

			deltas, err := j.Apply(test.changes)
			wantDeltas, wantErr := r.apply(test.changes)

			if err != wantErr {
				t.Fatalf("error mismatch\n got %v\nwant %v", err, wantErr)
			}
			if !reflect.DeepEqual(deltaMap(deltas), wantDeltas) {
				t.Fatalf("delta mismatch\n got %v\nwant %v", deltaMap(deltas), wantDeltas)
			}

			got := map[[2]string]int64{}
			for pair, weight := range deltaMap(deltas) {
				if !weight.IsInt64() {
					t.Fatalf("weight for %v does not fit int64: %s", pair, weight)
				}
				got[pair] = weight.Int64()
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("scalar delta mismatch\n got %v\nwant %v", got, test.want)
			}

			assertOrder(t, deltas)
			assertStateEqual(t, j, r)
		})
	}
}

func TestLargeIntegersDoNotOverflow(t *testing.T) {
	j := NewJoin()

	leftWeight := new(big.Int).Exp(big.NewInt(10), big.NewInt(40), nil)
	rightWeight := new(big.Int).Exp(big.NewInt(10), big.NewInt(30), nil)

	deltas, err := j.Apply([]Change{
		{Side: Left, RowID: []byte("l1"), Key: []byte("k"), Weight: leftWeight},
		{Side: Right, RowID: []byte("r1"), Key: []byte("k"), Weight: rightWeight},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := new(big.Int).Exp(big.NewInt(10), big.NewInt(70), nil)
	if len(deltas) != 1 || deltas[0].Weight.Cmp(want) != 0 {
		t.Fatalf("large product mismatch\n got %v\nwant %s", deltas, want)
	}
}
