package dataeng

import "testing"

func TestMergeSkipsDeletedAndFutureEntries(t *testing.T) {
	manifests := []ManifestFile{
		{
			ManifestPath:   "manifests/data-1.avro",
			SequenceNumber: 1,
			Entries: []ManifestEntry{
				{Status: EntryStatusAdded, DataFile: NewDataFile("data/a.parquet", 0, nil)},
				{Status: EntryStatusDeleted, DataFile: NewDataFile("data/gone.parquet", 0, nil)},
			},
		},
		{
			ManifestPath:   "manifests/future-delete.avro",
			Content:        ManifestContentDeletes,
			SequenceNumber: 9,
			Entries: []ManifestEntry{{
				Status:             EntryStatusAdded,
				DataSequenceNumber: seqPtr(9),
				DataFile:           NewPositionDeleteFile("deletes/future.parquet", "", 0, nil),
			}},
		},
	}
	set, err := MergeManifests(manifests, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(set.DataFiles) != 1 {
		t.Fatalf("want one live data file, got %d", len(set.DataFiles))
	}
	if len(set.DeleteFiles) != 0 {
		t.Fatalf("future delete leaked into merged set: %v", deletePaths(set.DeleteFiles))
	}
	if set.IgnoredDeletedEntries != 1 {
		t.Fatalf("deleted counter: %d", set.IgnoredDeletedEntries)
	}
	if set.IgnoredFutureEntries != 1 {
		t.Fatalf("future counter: %d", set.IgnoredFutureEntries)
	}
}

func TestMergeDeduplicatesBindingsDeterministically(t *testing.T) {
	manifests := []ManifestFile{
		{
			ManifestPath:   "manifests/old.avro",
			SequenceNumber: 1,
			Entries: []ManifestEntry{{
				Status:             EntryStatusAdded,
				DataSequenceNumber: seqPtr(1),
				DataFile:           NewDataFile("data/a.parquet", 0, nil),
			}},
		},
		{
			ManifestPath:   "manifests/rewritten.avro",
			SequenceNumber: 2,
			Entries: []ManifestEntry{{
				Status:             EntryStatusExisting,
				DataSequenceNumber: seqPtr(1),
				FileSequenceNumber: seqPtr(2),
				DataFile:           NewDataFile("data/a.parquet", 0, nil),
			}},
		},
	}
	set, err := MergeManifests(manifests, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(set.DataFiles) != 1 {
		t.Fatalf("want deduplicated data file, got %d", len(set.DataFiles))
	}
	if set.DeduplicatedEntries != 1 {
		t.Fatalf("dedup counter: %d", set.DeduplicatedEntries)
	}
	if set.DataFiles[0].DataSequenceNumber != 1 || set.DataFiles[0].FileSequenceNumber != 2 {
		t.Fatalf("unexpected winning binding: %+v", set.DataFiles[0])
	}
}

func TestMergeAppliesTombstonesInSequenceOrder(t *testing.T) {
	manifests := []ManifestFile{
		{
			ManifestPath:   "manifests/add-1.avro",
			SequenceNumber: 1,
			Entries: []ManifestEntry{{
				Status:   EntryStatusAdded,
				DataFile: NewDataFile("data/a.parquet", 0, nil),
			}},
		},
		{
			ManifestPath:   "manifests/delete-2.avro",
			SequenceNumber: 2,
			Entries: []ManifestEntry{{
				Status:   EntryStatusDeleted,
				DataFile: NewDataFile("data/a.parquet", 0, nil),
			}},
		},
	}
	set, err := MergeManifests(manifests, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(set.DataFiles) != 0 {
		t.Fatalf("tombstoned file remained live: %v", set.DataFiles[0].Path())
	}

	manifests = append(manifests, ManifestFile{
		ManifestPath:   "manifests/readd-3.avro",
		SequenceNumber: 3,
		Entries: []ManifestEntry{{
			Status:   EntryStatusAdded,
			DataFile: NewDataFile("data/a.parquet", 0, nil),
		}},
	})
	set, err = MergeManifests(manifests, 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(set.DataFiles) != 1 {
		t.Fatalf("later re-add should be live, got %d data files", len(set.DataFiles))
	}
}
