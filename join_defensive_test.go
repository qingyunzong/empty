package dataeng

import (
	"math/big"
	"testing"
)

func TestCallerMutationsDoNotAffectState(t *testing.T) {
	j := NewJoin()

	rowID := []byte("l1")
	key := []byte("k")
	weight := big.NewInt(5)

	if _, err := j.Apply([]Change{
		{Side: Left, RowID: rowID, Key: key, Weight: weight},
		{Side: Right, RowID: []byte("r1"), Key: []byte("k"), Weight: big.NewInt(2)},
	}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	key[0] = 'z'
	rowID[0] = 'x'
	weight.SetInt64(999)

	deltas, err := j.Apply([]Change{
		{Side: Right, RowID: []byte("r1"), Key: []byte("k"), Weight: big.NewInt(1)},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := map[[2]string]int64{{"l1", "r1"}: 5}
	if len(deltas) != 1 ||
		string(deltas[0].LeftRowID) != "l1" ||
		string(deltas[0].RightRowID) != "r1" ||
		deltas[0].Weight.Int64() != want[[2]string{"l1", "r1"}] {
		t.Fatalf("state was corrupted by caller mutation, deltas: %v", deltas)
	}
}
