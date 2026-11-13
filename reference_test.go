package dataeng

import (
	"reflect"
	"testing"
)

func referenceScenarioTable() *Table {
	table := NewTable()
	table.AddPartitionSpec(unpartitionedSpec())

	dataManifest := ManifestFile{
		ManifestPath:    "metadata/data-1.avro",
		PartitionSpecID: 2,
		Content:         ManifestContentData,
		SequenceNumber:  1,
		AddedSnapshotID: idPtr(1),
		Entries: []ManifestEntry{
			{Status: EntryStatusAdded, DataFile: NewDataFile("data/a.parquet", 2, nil)},
			{Status: EntryStatusAdded, DataFile: NewDataFile("data/b.parquet", 2, nil)},
		},
	}
	deleteManifest := ManifestFile{
		ManifestPath:    "metadata/delete-2.avro",
		PartitionSpecID: 2,
		Content:         ManifestContentDeletes,
		SequenceNumber:  2,
		AddedSnapshotID: idPtr(2),
		Entries: []ManifestEntry{
			{
				Status:             EntryStatusAdded,
				DataSequenceNumber: seqPtr(1),
				DataFile:           NewPositionDeleteFile("deletes/p1.parquet", "data/a.parquet", 2, nil),
			},
			{
				Status:             EntryStatusAdded,
				DataSequenceNumber: seqPtr(1),
				DataFile:           NewPositionDeleteFile("deletes/p2.parquet", "data/b.parquet", 2, nil),
			},
			{
				Status:   EntryStatusAdded,
				DataFile: NewEqualityDeleteFile("deletes/e1.parquet", []int{1}, 2, nil),
			},
			{
				Status:   EntryStatusAdded,
				DataFile: NewEqualityDeleteFile("deletes/e2.parquet", []int{1}, 2, nil),
			},
		},
	}
	table.AddSnapshot(Snapshot{
		SnapshotID:     1,
		SequenceNumber: 1,
		Manifests:      []ManifestFile{dataManifest},
	})
	table.AddSnapshot(Snapshot{
		SnapshotID:       2,
		ParentSnapshotID: idPtr(1),
		SequenceNumber:   2,
		Manifests:        []ManifestFile{dataManifest, deleteManifest},
	})
	if err := table.SetCurrentSnapshot(2); err != nil {
		panic(err)
	}
	return table
}

func referenceRows() []ReferenceRow {
	return []ReferenceRow{
		{Values: map[string]any{"id": 1}, FilePath: "data/a.parquet", Position: 0, DataSequenceNumber: 1},
		{Values: map[string]any{"id": 2}, FilePath: "data/a.parquet", Position: 1, DataSequenceNumber: 1},
		{Values: map[string]any{"id": 3}, FilePath: "data/b.parquet", Position: 0, DataSequenceNumber: 2},
		{Values: map[string]any{"id": 4}, FilePath: "data/b.parquet", Position: 1, DataSequenceNumber: 2},
	}
}

func referenceReader() DeleteRecordReader {
	return DeleteRecordReaderFunc{
		Position: func(file *DataFile) ([]ReferencePositionDelete, error) {
			switch file.FilePath {
			case "deletes/p1.parquet":
				return []ReferencePositionDelete{{
					FilePath:           "data/a.parquet",
					Position:           0,
					DataSequenceNumber: 1,
				}}, nil
			case "deletes/p2.parquet":
				return []ReferencePositionDelete{{
					FilePath:           "data/b.parquet",
					Position:           0,
					DataSequenceNumber: 1,
				}}, nil
			default:
				return nil, nil
			}
		},
		Equality: func(file *DataFile) ([]ReferenceEqualityDelete, error) {
			switch file.FilePath {
			case "deletes/e1.parquet":
				return []ReferenceEqualityDelete{{
					Values:             map[string]any{"id": 2},
					DataSequenceNumber: 2,
				}}, nil
			case "deletes/e2.parquet":
				return []ReferenceEqualityDelete{{
					Values:             map[string]any{"id": 3},
					DataSequenceNumber: 2,
				}}, nil
			default:
				return nil, nil
			}
		},
	}
}

func TestReferenceMatchesPlannerBindings(t *testing.T) {
	table := referenceScenarioTable()
	plan := mustPlan(t, table, 2, nil)
	if err := VerifyPlan(plan, referenceRows(), referenceReader()); err != nil {
		t.Fatal(err)
	}

	rows := ApplyReferenceDeletes(
		referenceRows(),
		[]ReferencePositionDelete{
			{FilePath: "data/a.parquet", Position: 0, DataSequenceNumber: 1},
			{FilePath: "data/b.parquet", Position: 0, DataSequenceNumber: 1},
		},
		[]ReferenceEqualityDelete{
			{Values: map[string]any{"id": 2}, DataSequenceNumber: 2},
			{Values: map[string]any{"id": 3}, DataSequenceNumber: 2},
		},
	)
	want := []ReferenceRow{
		{Values: map[string]any{"id": 3}, FilePath: "data/b.parquet", Position: 0, DataSequenceNumber: 2},
		{Values: map[string]any{"id": 4}, FilePath: "data/b.parquet", Position: 1, DataSequenceNumber: 2},
	}
	if !reflect.DeepEqual(rows, want) {
		t.Fatalf("reference rows mismatch:\n got %+v\nwant %+v", rows, want)
	}
}

func TestReferenceHonoursSequenceBoundary(t *testing.T) {
	row := ReferenceRow{
		Values:             map[string]any{"id": 10},
		FilePath:           "data/a.parquet",
		Position:           7,
		DataSequenceNumber: 5,
	}
	if !PositionDeleteMatchesRow(row, ReferencePositionDelete{
		FilePath: "data/a.parquet", Position: 7, DataSequenceNumber: 5,
	}) {
		t.Fatal("position delete must apply at the same sequence")
	}
	if EqualityDeleteMatchesRow(row, ReferenceEqualityDelete{
		Values: map[string]any{"id": 10}, DataSequenceNumber: 5,
	}) {
		t.Fatal("equality delete must not apply at the same sequence")
	}
	if !EqualityDeleteMatchesRow(row, ReferenceEqualityDelete{
		Values: map[string]any{"id": 10}, DataSequenceNumber: 6,
	}) {
		t.Fatal("equality delete must apply when it is newer")
	}
}
