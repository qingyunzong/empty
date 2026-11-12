package dataeng_test

import (
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"testing"

	"example.org/dataeng/q0101"
)

func TestStrictEqualitySequenceBoundary(t *testing.T) {
	keyType := dataeng.KeyTypeInt64
	deletes := []dataeng.Delete{
		dataeng.NewEqualityDelete("delete-equal", 7, int64(10)),
		dataeng.NewEqualityDelete("delete-after", 8, int64(10)),
	}

	index, err := dataeng.BuildDeleteIndex(keyType, deletes)
	if err != nil {
		t.Fatalf("BuildDeleteIndex: %v", err)
	}

	rows := []dataeng.DataRow{
		{FileID: "data-a", RowNumber: 1, Key: int64(10), DataSequenceNumber: 7},
		{FileID: "data-a", RowNumber: 2, Key: int64(10), DataSequenceNumber: 6},
		{FileID: "data-a", RowNumber: 3, Key: int64(10), DataSequenceNumber: 8},
	}
	got, err := index.Scan(rows)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}

	// A delete with the same sequence number is not applicable. Equality
	// deletes require dataSequenceNumber < deleteSequenceNumber.
	if got[0].Visible() || got[0].Evidence.SequenceNumber != 8 {
		t.Fatalf("equal sequence row: got %+v, want delete with sequence 8", got[0])
	}
	if !got[1].Deleted || got[1].Evidence.SequenceNumber != 7 {
		t.Fatalf("older row: got %+v, want delete with sequence 7", got[1])
	}
	if got[2].Deleted {
		t.Fatalf("newer row: got %+v, want visible", got[2])
	}
}

func TestPositionDeleteIgnoresKeyAndSequence(t *testing.T) {
	deletes := []dataeng.Delete{
		dataeng.NewPositionDelete("delete-pos", 0, "data-a", 4),
	}
	index, err := dataeng.BuildDeleteIndex(dataeng.KeyTypeString, deletes)
	if err != nil {
		t.Fatalf("BuildDeleteIndex: %v", err)
	}

	// Position deletes only use file ID and row number.
	got, err := index.Scan([]dataeng.DataRow{
		{FileID: "data-a", RowNumber: 4, Key: "different", DataSequenceNumber: 99},
		{FileID: "data-b", RowNumber: 4, Key: "different", DataSequenceNumber: 99},
		{FileID: "data-a", RowNumber: 5, Key: "different", DataSequenceNumber: 99},
	})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if !got[0].Deleted {
		t.Fatalf("position delete did not match same file and row: %+v", got[0])
	}
	if got[1].Deleted || got[2].Deleted {
		t.Fatalf("position delete matched wrong file or row: %+v", got)
	}
}

func TestNullKeysCompareByValue(t *testing.T) {
	deletes := []dataeng.Delete{
		dataeng.NewEqualityDelete("delete-null", 5, nil),
		dataeng.NewEqualityDelete("delete-zero", 6, int64(0)),
	}
	index, err := dataeng.BuildDeleteIndex(dataeng.KeyTypeInt64, deletes)
	if err != nil {
		t.Fatalf("BuildDeleteIndex: %v", err)
	}
	got, err := index.Scan([]dataeng.DataRow{
		{FileID: "data-a", RowNumber: 1, Key: nil, DataSequenceNumber: 1},
		{FileID: "data-a", RowNumber: 2, Key: int64(0), DataSequenceNumber: 1},
		{FileID: "data-a", RowNumber: 3, Key: int64(1), DataSequenceNumber: 1},
	})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if !got[0].Deleted || got[0].Evidence.SequenceNumber != 5 {
		t.Fatalf("NULL key: got %+v, want NULL equality delete", got[0])
	}
	if !got[1].Deleted || got[1].Evidence.SequenceNumber != 6 {
		t.Fatalf("zero key: got %+v, want zero equality delete", got[1])
	}
	if got[2].Deleted {
		t.Fatalf("non-matching key deleted: %+v", got[2])
	}

	strDeletes := []dataeng.Delete{
		dataeng.NewEqualityDelete("delete-null", 5, nil),
		dataeng.NewEqualityDelete("delete-empty", 6, ""),
	}
	strIndex, err := dataeng.BuildDeleteIndex(dataeng.KeyTypeString, strDeletes)
	if err != nil {
		t.Fatalf("BuildDeleteIndex(string): %v", err)
	}
	strGot, err := strIndex.Scan([]dataeng.DataRow{
		{FileID: "data-a", RowNumber: 1, Key: nil, DataSequenceNumber: 1},
		{FileID: "data-a", RowNumber: 2, Key: "", DataSequenceNumber: 1},
	})
	if err != nil {
		t.Fatalf("Scan(string): %v", err)
	}
	if !strGot[0].Deleted || strGot[0].Evidence.SequenceNumber != 5 {
		t.Fatalf("NULL string key: got %+v", strGot[0])
	}
	if !strGot[1].Deleted || strGot[1].Evidence.SequenceNumber != 6 {
		t.Fatalf("empty string key: got %+v", strGot[1])
	}
}

func TestPositionAndEqualityDeletesCoexist(t *testing.T) {
	deletes := []dataeng.Delete{
		dataeng.NewPositionDelete("delete-z", 7, "data-a", 1),
		dataeng.NewEqualityDelete("delete-a", 8, int64(10)),
		dataeng.NewEqualityDelete("delete-b", 8, int64(10)),
		dataeng.NewPositionDelete("delete-c", 8, "data-a", 1),
	}
	index, err := dataeng.BuildDeleteIndex(dataeng.KeyTypeInt64, deletes)
	if err != nil {
		t.Fatalf("BuildDeleteIndex: %v", err)
	}
	rows := []dataeng.DataRow{
		{FileID: "data-a", RowNumber: 1, Key: int64(10), DataSequenceNumber: 2},
		{FileID: "data-a", RowNumber: 1, Key: int64(99), DataSequenceNumber: 2},
		{FileID: "data-a", RowNumber: 2, Key: int64(10), DataSequenceNumber: 2},
	}
	got, err := index.Scan(rows)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}

	// Position delete sequence 7 beats equality delete sequence 8; the
	// sequence-8 equality delete with file ID "delete-a" beats the equal
	// sequence position delete with file ID "delete-c".
	if !got[0].Deleted || got[0].Evidence.Kind != dataeng.PositionDeleteKind ||
		got[0].Evidence.DeleteFileID != "delete-z" || got[0].Evidence.SequenceNumber != 7 {
		t.Fatalf("coexisting deletes: got %+v, want earliest position delete", got[0])
	}
	if !got[1].Deleted || got[1].Evidence.Kind != dataeng.PositionDeleteKind ||
		got[1].Evidence.DeleteFileID != "delete-z" {
		t.Fatalf("position-only row: got %+v, want position delete", got[1])
	}
	if !got[2].Deleted || got[2].Evidence.Kind != dataeng.EqualityDeleteKind ||
		got[2].Evidence.DeleteFileID != "delete-a" || got[2].Evidence.SequenceNumber != 8 {
		t.Fatalf("equality tie-break: got %+v, want delete-a", got[2])
	}
}

func TestDeleteFileIDBreaksSequenceTie(t *testing.T) {
	deletes := []dataeng.Delete{
		dataeng.NewEqualityDelete("delete-b", 4, "same"),
		dataeng.NewEqualityDelete("delete-a", 4, "same"),
		dataeng.NewPositionDelete("delete-c", 4, "data-a", 3),
		dataeng.NewPositionDelete("delete-0", 4, "data-a", 3),
	}
	index, err := dataeng.BuildDeleteIndex(dataeng.KeyTypeString, deletes)
	if err != nil {
		t.Fatalf("BuildDeleteIndex: %v", err)
	}

	got, err := index.Scan([]dataeng.DataRow{
		{FileID: "data-a", RowNumber: 3, Key: "same", DataSequenceNumber: 0},
	})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if !got[0].Deleted || got[0].Evidence.DeleteFileID != "delete-0" {
		t.Fatalf("tie-break: got %+v, want delete-0", got[0])
	}
}

func TestMultiFileInterleavedBatches(t *testing.T) {
	deletes := []dataeng.Delete{
		dataeng.NewPositionDelete("delete-2", 3, "data-b", 0),
		dataeng.NewEqualityDelete("delete-1", 5, "k"),
		dataeng.NewPositionDelete("delete-3", 4, "data-a", 1),
		dataeng.NewEqualityDelete("delete-0", 7, "k"),
	}
	index, err := dataeng.BuildDeleteIndex(dataeng.KeyTypeString, deletes)
	if err != nil {
		t.Fatalf("BuildDeleteIndex: %v", err)
	}

	rows := []dataeng.DataRow{
		{FileID: "data-a", RowNumber: 0, Key: "k", DataSequenceNumber: 2},
		{FileID: "data-b", RowNumber: 0, Key: "k", DataSequenceNumber: 2},
		{FileID: "data-a", RowNumber: 1, Key: "x", DataSequenceNumber: 2},
		{FileID: "data-b", RowNumber: 1, Key: "k", DataSequenceNumber: 2},
		{FileID: "data-c", RowNumber: 0, Key: "k", DataSequenceNumber: 2},
	}

	batchOne, err := index.ScanBatch(rows[:2])
	if err != nil {
		t.Fatalf("ScanBatch one: %v", err)
	}
	batchTwo, err := index.ScanBatch(rows[2:])
	if err != nil {
		t.Fatalf("ScanBatch two: %v", err)
	}
	all, err := index.Scan(rows)
	if err != nil {
		t.Fatalf("Scan all: %v", err)
	}

	combined := append(append([]dataeng.RowVisibility{}, batchOne...), batchTwo...)
	for i := range rows {
		if !reflect.DeepEqual(combined[i], all[i]) {
			t.Fatalf("row %d differs between batch and full scan: batch=%+v full=%+v", i, combined[i], all[i])
		}
	}

	want := []struct {
		deleted bool
		fileID  string
	}{
		{true, "delete-1"},
		{true, "delete-2"},
		{true, "delete-3"},
		{true, "delete-1"},
		{true, "delete-1"},
	}
	for i := range want {
		if all[i].Deleted != want[i].deleted || (all[i].Deleted && all[i].Evidence.DeleteFileID != want[i].fileID) {
			t.Fatalf("row %d: got %+v, want deleted=%v evidence=%s", i, all[i], want[i].deleted, want[i].fileID)
		}
	}
}

func TestIndexValidationHappensBeforeScanning(t *testing.T) {
	valid := dataeng.NewEqualityDelete("delete-a", 1, int64(1))
	invalid := dataeng.NewEqualityDelete("delete-b", 2, "wrong type")

	index, err := dataeng.BuildDeleteIndex(dataeng.KeyTypeInt64, []dataeng.Delete{valid, invalid})
	if index != nil {
		t.Fatalf("BuildDeleteIndex returned an index with an invalid delete: %+v", index)
	}
	if !errors.Is(err, dataeng.ErrKeyTypeMismatch) {
		t.Fatalf("BuildDeleteIndex error = %v, want ErrKeyTypeMismatch", err)
	}

	index, err = dataeng.BuildDeleteIndex(dataeng.KeyTypeInvalid, []dataeng.Delete{valid})
	if index != nil || !errors.Is(err, dataeng.ErrInvalidKeyType) {
		t.Fatalf("invalid key type: index=%+v err=%v", index, err)
	}

	index, err = dataeng.BuildDeleteIndex(dataeng.KeyTypeInt64, []dataeng.Delete{{Kind: 99}})
	if index != nil || !errors.Is(err, dataeng.ErrInvalidDeleteKind) {
		t.Fatalf("invalid delete kind: index=%+v err=%v", index, err)
	}

	index, err = dataeng.BuildDeleteIndex(dataeng.KeyTypeInt64, []dataeng.Delete{
		dataeng.NewPositionDelete("delete-a", 1, "data-a", -1),
	})
	if index != nil || !errors.Is(err, dataeng.ErrInvalidRowNumber) {
		t.Fatalf("negative position: index=%+v err=%v", index, err)
	}
}

func TestScanRejectsWrongDataKeyTypeWithoutPartialResults(t *testing.T) {
	index, err := dataeng.BuildDeleteIndex(dataeng.KeyTypeInt64, []dataeng.Delete{
		dataeng.NewEqualityDelete("delete-a", 2, int64(1)),
	})
	if err != nil {
		t.Fatalf("BuildDeleteIndex: %v", err)
	}

	results, err := index.Scan([]dataeng.DataRow{
		{FileID: "data-a", RowNumber: 0, Key: int64(1), DataSequenceNumber: 0},
		{FileID: "data-a", RowNumber: 1, Key: "not-int64", DataSequenceNumber: 0},
	})
	if results != nil {
		t.Fatalf("Scan returned partial results: %+v", results)
	}
	if !errors.Is(err, dataeng.ErrKeyTypeMismatch) {
		t.Fatalf("Scan error = %v, want ErrKeyTypeMismatch", err)
	}

	if evidence, err := index.FirstDelete(dataeng.DataRow{
		FileID: "data-a", RowNumber: 2, Key: "not-int64", DataSequenceNumber: 0,
	}); evidence != nil || !errors.Is(err, dataeng.ErrKeyTypeMismatch) {
		t.Fatalf("FirstDelete: evidence=%+v err=%v", evidence, err)
	}
}

func TestInputsAreNotModified(t *testing.T) {
	deletes := []dataeng.Delete{
		dataeng.NewEqualityDelete("delete-c", 5, int64(3)),
		dataeng.NewPositionDelete("delete-b", 1, "data-b", 7),
		dataeng.NewEqualityDelete("delete-a", 2, nil),
		dataeng.NewPositionDelete("delete-d", 9, "data-a", 1),
	}
	rows := []dataeng.DataRow{
		{FileID: "data-b", RowNumber: 7, Key: int64(3), DataSequenceNumber: 0},
		{FileID: "data-a", RowNumber: 1, Key: nil, DataSequenceNumber: 0},
		{FileID: "data-c", RowNumber: 0, Key: int64(3), DataSequenceNumber: 2},
	}
	deletesBefore := cloneDeletes(deletes)
	rowsBefore := cloneRows(rows)

	index, err := dataeng.BuildDeleteIndex(dataeng.KeyTypeInt64, deletes)
	if err != nil {
		t.Fatalf("BuildDeleteIndex: %v", err)
	}
	results, err := index.Scan(rows)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if !reflect.DeepEqual(deletes, deletesBefore) {
		t.Fatalf("deletes modified:\nbefore=%+v\nafter =%+v", deletesBefore, deletes)
	}
	if !reflect.DeepEqual(rows, rowsBefore) {
		t.Fatalf("rows modified:\nbefore=%+v\nafter =%+v", rowsBefore, rows)
	}

	// Evidence returned to the caller is a copy, not a pointer into the index.
	results[0].Evidence.DeleteFileID = "mutated"
	fresh, err := index.FirstDelete(rows[0])
	if err != nil {
		t.Fatalf("FirstDelete: %v", err)
	}
	if fresh == nil || fresh.DeleteFileID != "delete-b" {
		t.Fatalf("index changed through evidence pointer: %+v", fresh)
	}
}

func TestEmptyInputs(t *testing.T) {
	index, err := dataeng.BuildDeleteIndex(dataeng.KeyTypeString, nil)
	if err != nil {
		t.Fatalf("BuildDeleteIndex(nil): %v", err)
	}
	got, err := index.Scan(nil)
	if err != nil {
		t.Fatalf("Scan(nil): %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("Scan(nil) length = %d, want 0", len(got))
	}

	var nilIndex *dataeng.DeleteIndex
	if _, err := nilIndex.Scan([]dataeng.DataRow{{}}); !errors.Is(err, dataeng.ErrNilDeleteIndex) {
		t.Fatalf("nil index Scan error = %v", err)
	}
	if _, err := nilIndex.FirstDelete(dataeng.DataRow{}); !errors.Is(err, dataeng.ErrNilDeleteIndex) {
		t.Fatalf("nil index FirstDelete error = %v", err)
	}
}

// TestRowsAgainstFullReference generates interleaved deletes from several
// files and interleaved data rows, then compares every row's first delete
// evidence against a brute-force, row-by-row reference implementation.
func TestRowsAgainstFullReference(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))

	for iteration := 0; iteration < 300; iteration++ {
		keyType := dataeng.KeyTypeInt64
		if iteration%2 == 1 {
			keyType = dataeng.KeyTypeString
		}

		fileIDs := []string{"data-a", "data-b", "data-c", "data-d"}
		deleteFileIDs := []string{
			"delete-00", "delete-01", "delete-02", "delete-03", "delete-04",
			"delete-10", "delete-11", "delete-12", "delete-13", "delete-14",
		}
		keys := []any{nil, int64(-1), int64(0), int64(1), int64(2), "x", "y", ""}
		if keyType == dataeng.KeyTypeInt64 {
			keys = []any{nil, int64(-1), int64(0), int64(1), int64(2), int64(3)}
		} else {
			keys = []any{nil, "x", "y", "", "same", "other"}
		}

		rowCount := rng.Intn(100)
		rows := make([]dataeng.DataRow, rowCount)
		for i := range rows {
			rows[i] = dataeng.DataRow{
				FileID:             fileIDs[rng.Intn(len(fileIDs))],
				RowNumber:          int64(rng.Intn(20)),
				Key:                keys[rng.Intn(len(keys))],
				DataSequenceNumber: int64(rng.Intn(12)),
			}
		}

		deleteCount := rng.Intn(100)
		deletes := make([]dataeng.Delete, deleteCount)
		for i := range deletes {
			deleteFileID := deleteFileIDs[rng.Intn(len(deleteFileIDs))]
			sequenceNumber := int64(rng.Intn(12))
			if rng.Intn(2) == 0 {
				deletes[i] = dataeng.NewPositionDelete(
					deleteFileID,
					sequenceNumber,
					fileIDs[rng.Intn(len(fileIDs))],
					int64(rng.Intn(20)),
				)
			} else {
				deletes[i] = dataeng.NewEqualityDelete(
					deleteFileID,
					sequenceNumber,
					keys[rng.Intn(len(keys))],
				)
			}
		}

		index, err := dataeng.BuildDeleteIndex(keyType, deletes)
		if err != nil {
			t.Fatalf("iteration %d: BuildDeleteIndex: %v", iteration, err)
		}
		got, err := index.Scan(rows)
		if err != nil {
			t.Fatalf("iteration %d: Scan: %v", iteration, err)
		}

		for rowIndex := range rows {
			want, err := referenceVisibility(rows[rowIndex], deletes, keyType)
			if err != nil {
				t.Fatalf("iteration %d row %d: reference: %v", iteration, rowIndex, err)
			}
			if !sameVisibility(got[rowIndex], want) {
				t.Fatalf("iteration %d row %d: got %s, want %s\nrow=%+v\ndeletes=%+v",
					iteration, rowIndex, formatVisibility(got[rowIndex]), formatVisibility(want), rows[rowIndex], deletes)
			}
		}
	}
}

func referenceVisibility(row dataeng.DataRow, deletes []dataeng.Delete, keyType dataeng.KeyType) (result dataeng.RowVisibility, err error) {
	if row.RowNumber < 0 {
		return result, fmt.Errorf("negative data row number %d", row.RowNumber)
	}
	if err := validateReferenceKey(row.Key, keyType); err != nil {
		return result, err
	}

	var best dataeng.DeleteEvidence
	bestOrder := -1
	haveBest := false

	for i := range deletes {
		delete := deletes[i]
		var evidence dataeng.DeleteEvidence

		switch delete.Kind {
		case dataeng.PositionDeleteKind:
			if delete.DataFileID != row.FileID || delete.RowNumber != row.RowNumber {
				continue
			}
			evidence = dataeng.DeleteEvidence{
				Kind:           delete.Kind,
				DeleteFileID:   delete.DeleteFileID,
				SequenceNumber: delete.SequenceNumber,
				DataFileID:     delete.DataFileID,
				RowNumber:      delete.RowNumber,
			}

		case dataeng.EqualityDeleteKind:
			if err := validateReferenceKey(delete.Key, keyType); err != nil {
				return result, fmt.Errorf("delete %d: %w", i, err)
			}
			if delete.SequenceNumber <= row.DataSequenceNumber {
				continue
			}
			equal := sameReferenceKey(delete.Key, row.Key)
			if !equal {
				continue
			}
			evidence = dataeng.DeleteEvidence{
				Kind:           delete.Kind,
				DeleteFileID:   delete.DeleteFileID,
				SequenceNumber: delete.SequenceNumber,
				Key:            delete.Key,
			}

		default:
			return result, fmt.Errorf("%w: %d", dataeng.ErrInvalidDeleteKind, delete.Kind)
		}

		if !haveBest || referenceEvidenceLess(evidence, i, best, bestOrder) {
			best = evidence
			bestOrder = i
			haveBest = true
		}
	}

	if !haveBest {
		return dataeng.RowVisibility{}, nil
	}
	bestCopy := best
	return dataeng.RowVisibility{Deleted: true, Evidence: &bestCopy}, nil
}

func validateReferenceKey(key any, keyType dataeng.KeyType) error {
	switch key.(type) {
	case nil:
		return nil
	case int64:
		if keyType == dataeng.KeyTypeInt64 {
			return nil
		}
	case string:
		if keyType == dataeng.KeyTypeString {
			return nil
		}
	}
	return fmt.Errorf("%w: got %T, want %s", dataeng.ErrKeyTypeMismatch, key, keyType)
}

func sameReferenceKey(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	switch a.(type) {
	case int64:
		return a.(int64) == b.(int64)
	case string:
		return a.(string) == b.(string)
	default:
		return false
	}
}

func referenceEvidenceLess(a dataeng.DeleteEvidence, aOrder int, b dataeng.DeleteEvidence, bOrder int) bool {
	if a.SequenceNumber != b.SequenceNumber {
		return a.SequenceNumber < b.SequenceNumber
	}
	if a.DeleteFileID != b.DeleteFileID {
		return a.DeleteFileID < b.DeleteFileID
	}
	return aOrder < bOrder
}

func sameVisibility(got, want dataeng.RowVisibility) bool {
	if got.Deleted != want.Deleted {
		return false
	}
	if !got.Deleted {
		return got.Evidence == nil && want.Evidence == nil
	}
	if got.Evidence == nil || want.Evidence == nil {
		return false
	}
	return reflect.DeepEqual(*got.Evidence, *want.Evidence)
}

func formatVisibility(v dataeng.RowVisibility) string {
	if !v.Deleted {
		return "visible"
	}
	if v.Evidence == nil {
		return "deleted without evidence"
	}
	return fmt.Sprintf("deleted by %s(seq=%d kind=%d target=%s/%d key=%v)",
		v.Evidence.DeleteFileID, v.Evidence.SequenceNumber, v.Evidence.Kind,
		v.Evidence.DataFileID, v.Evidence.RowNumber, v.Evidence.Key)
}

func cloneDeletes(in []dataeng.Delete) []dataeng.Delete {
	out := make([]dataeng.Delete, len(in))
	copy(out, in)
	return out
}

func cloneRows(in []dataeng.DataRow) []dataeng.DataRow {
	out := make([]dataeng.DataRow, len(in))
	copy(out, in)
	return out
}
