package dataeng

import (
	"errors"
	"reflect"
	"testing"
)

func TestMaskBitAndColumns(t *testing.T) {
	t.Parallel()

	mask := []byte{0b00000101, 0b00000010}
	for ordinal, want := range map[int]bool{1: true, 2: false, 3: true, 10: true, 11: false} {
		if got := MaskBit(mask, ordinal); got != want {
			t.Fatalf("MaskBit(%d) = %v, want %v", ordinal, got, want)
		}
	}
	got := MaskColumns(mask, []string{"id", "name", "age"})
	if !reflect.DeepEqual(got, []string{"id", "age"}) {
		t.Fatalf("MaskColumns() = %#v", got)
	}
}

func TestCombineUpdateImages(t *testing.T) {
	t.Parallel()

	lsn := MustParseLSN("0000002a:0000005c:0003")
	seq := MustParseLSN("0000002a:0000005c:0003")
	rows := []ChangeRow{
		{
			StartLSN:   lsn,
			SeqVal:     seq,
			Operation:  OperationUpdateAfter,
			UpdateMask: []byte{0x05},
			Values:     map[string]any{"id": int64(7), "name": "new", "age": int64(42)},
		},
		{
			StartLSN:   lsn,
			SeqVal:     seq,
			Operation:  OperationUpdateBefore,
			UpdateMask: []byte{0x05},
			Values:     map[string]any{"id": int64(7), "name": "old", "age": int64(41)},
		},
	}

	changes, err := CombineChangesWithColumns(rows, []string{"id", "name", "age"})
	if err != nil {
		t.Fatalf("CombineChangesWithColumns() error = %v", err)
	}
	if len(changes) != 1 {
		t.Fatalf("len(changes) = %d", len(changes))
	}
	change := changes[0]
	if change.Kind != KindUpdate || change.Operation != OperationUpdateAfter {
		t.Fatalf("unexpected change: %#v", change)
	}
	if change.Before["name"] != "old" || change.After["name"] != "new" {
		t.Fatalf("before/after not combined: %#v", change)
	}
	if !reflect.DeepEqual(change.ChangedColumns, []string{"id", "age"}) {
		t.Fatalf("ChangedColumns = %#v", change.ChangedColumns)
	}

	merged := change.Apply(map[string]any{"id": int64(7), "name": "old", "age": int64(41)})
	if !reflect.DeepEqual(merged, map[string]any{"id": int64(7), "name": "old", "age": int64(42)}) {
		t.Fatalf("Apply() = %#v", merged)
	}
}

func TestCombineMasksBeforeAndAfter(t *testing.T) {
	t.Parallel()

	lsn := MustParseLSN("0000002a:0000005c:0004")
	rows := []ChangeRow{
		{StartLSN: lsn, SeqVal: lsn, Operation: OperationUpdateBefore, UpdateMask: []byte{0x01}, Values: map[string]any{"id": 1}},
		{StartLSN: lsn, SeqVal: lsn, Operation: OperationUpdateAfter, UpdateMask: []byte{0x02}, Values: map[string]any{"id": 2}},
	}
	changes, err := CombineChangesWithColumns(rows, []string{"id", "name"})
	if err != nil {
		t.Fatalf("CombineChangesWithColumns() error = %v", err)
	}
	if len(changes) != 1 || len(changes[0].ChangedColumns) != 2 {
		t.Fatalf("changes = %#v", changes)
	}
}

func TestCombineInsertsDeletesAndOrdering(t *testing.T) {
	t.Parallel()

	lsn1 := MustParseLSN("0000002a:0000005c:0001")
	lsn2 := MustParseLSN("0000002a:0000005c:0002")
	rows := []ChangeRow{
		{StartLSN: lsn2, SeqVal: lsn2, Operation: OperationDelete, Values: map[string]any{"id": 2}},
		{StartLSN: lsn1, SeqVal: lsn1, Operation: OperationInsert, Values: map[string]any{"id": 1}},
	}
	changes, err := CombineChanges(rows)
	if err != nil {
		t.Fatalf("CombineChanges() error = %v", err)
	}
	if len(changes) != 2 {
		t.Fatalf("len(changes) = %d", len(changes))
	}
	if changes[0].Kind != KindInsert || changes[1].Kind != KindDelete {
		t.Fatalf("changes order = %#v", changes)
	}
}

func TestCombineReplayAndErrors(t *testing.T) {
	t.Parallel()

	lsn := MustParseLSN("0000002a:0000005c:0005")
	insert := ChangeRow{StartLSN: lsn, SeqVal: lsn, Operation: OperationInsert, Values: map[string]any{"id": 1}}
	changes, err := CombineChanges([]ChangeRow{insert, insert})
	if err != nil {
		t.Fatalf("duplicate replay error = %v", err)
	}
	if len(changes) != 1 {
		t.Fatalf("duplicate replay produced %d changes", len(changes))
	}

	conflicting := insert
	conflicting.Values = map[string]any{"id": 2}
	if _, err := CombineChanges([]ChangeRow{insert, conflicting}); !errors.Is(err, ErrConflictingChange) {
		t.Fatalf("conflicting duplicate error = %v", err)
	}

	onlyBefore := ChangeRow{StartLSN: lsn, SeqVal: lsn, Operation: OperationUpdateBefore, Values: map[string]any{"id": 1}}
	if _, err := CombineChanges([]ChangeRow{onlyBefore}); !errors.Is(err, ErrIncompleteUpdate) {
		t.Fatalf("incomplete update error = %v", err)
	}

	unknown := ChangeRow{StartLSN: lsn, SeqVal: lsn, Operation: 9}
	if _, err := CombineChanges([]ChangeRow{unknown}); !errors.Is(err, ErrUnknownOperation) {
		t.Fatalf("unknown operation error = %v", err)
	}
}

func TestMergeMasked(t *testing.T) {
	t.Parallel()

	before := map[string]any{"id": 1, "name": "old", "age": 40}
	after := map[string]any{"id": 99, "name": "new", "age": 41}
	merged := MergeMasked(before, after, []byte{0x05}, []string{"id", "name", "age"})
	if !reflect.DeepEqual(merged, map[string]any{"id": 99, "name": "old", "age": 41}) {
		t.Fatalf("MergeMasked() = %#v", merged)
	}
}

func TestFilterChangesAfter(t *testing.T) {
	t.Parallel()

	firstLSN := MustParseLSN("0000002a:0000005c:0001")
	secondLSN := MustParseLSN("0000002a:0000005c:0002")
	changes := []Change{
		{StartLSN: firstLSN, SeqVal: firstLSN, Kind: KindInsert, Operation: OperationInsert},
		{StartLSN: secondLSN, SeqVal: secondLSN, Kind: KindInsert, Operation: OperationInsert},
	}
	filtered := FilterChangesAfter(changes, Position{
		StartLSN:  firstLSN,
		SeqVal:    firstLSN,
		Operation: OperationInsert,
	})
	if len(filtered) != 1 || !filtered[0].StartLSN.Equal(secondLSN) {
		t.Fatalf("FilterChangesAfter() = %#v", filtered)
	}
}
