package dataeng

import "testing"

func TestResolveEntryInheritsManifestSequence(t *testing.T) {
	manifest := ManifestFile{
		ManifestPath:    "manifests/data.avro",
		PartitionSpecID: 0,
		SequenceNumber:  7,
		AddedSnapshotID: idPtr(70),
		Entries: []ManifestEntry{{
			Status:   EntryStatusAdded,
			DataFile: NewDataFile("data/a.parquet", 0, Partition{"region": "us"}),
		}},
	}
	resolved, err := ResolveManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if len(resolved) != 1 {
		t.Fatalf("want 1 entry, got %d", len(resolved))
	}
	if resolved[0].DataSequenceNumber != 7 || resolved[0].FileSequenceNumber != 7 {
		t.Fatalf("sequence not inherited: data=%d file=%d",
			resolved[0].DataSequenceNumber, resolved[0].FileSequenceNumber)
	}
	if resolved[0].SnapshotID != 70 {
		t.Fatalf("snapshot id not inherited: %d", resolved[0].SnapshotID)
	}
}

func TestResolveEntryKeepsExplicitSequence(t *testing.T) {
	manifest := ManifestFile{
		ManifestPath:   "manifests/rewritten.avro",
		SequenceNumber: 9,
		Entries: []ManifestEntry{{
			Status:             EntryStatusExisting,
			DataSequenceNumber: seqPtr(3),
			FileSequenceNumber: seqPtr(8),
			DataFile:           NewPositionDeleteFile("deletes/p.parquet", "", 0, nil),
		}},
	}
	resolved, err := ResolveEntry(manifest.Entries[0], manifest)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.DataSequenceNumber != 3 {
		t.Fatalf("explicit data sequence was overwritten: %d", resolved.DataSequenceNumber)
	}
	if resolved.FileSequenceNumber != 8 {
		t.Fatalf("explicit file sequence was overwritten: %d", resolved.FileSequenceNumber)
	}
}

func TestDeleteSequenceBoundary(t *testing.T) {
	tests := []struct {
		name      string
		dataSeq   int64
		deleteSeq int64
		content   FileContent
		wantApply bool
	}{
		{"position same commit", 5, 5, FileContentPositionDeletes, true},
		{"position older data", 4, 5, FileContentPositionDeletes, true},
		{"position newer data", 6, 5, FileContentPositionDeletes, false},
		{"equality same commit", 5, 5, FileContentEqualityDeletes, false},
		{"equality older data", 4, 5, FileContentEqualityDeletes, true},
		{"equality newer data", 6, 5, FileContentEqualityDeletes, false},
		{"deletion vector same commit", 5, 5, FileContentDeletionVector, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DeleteApplies(tt.dataSeq, tt.deleteSeq, tt.content); got != tt.wantApply {
				t.Fatalf("DeleteApplies(%d,%d,%s)=%v want %v",
					tt.dataSeq, tt.deleteSeq, tt.content, got, tt.wantApply)
			}
		})
	}
}

func TestUnassignedSequenceInherits(t *testing.T) {
	manifest := ManifestFile{SequenceNumber: 4}
	resolved, err := ResolveEntry(ManifestEntry{
		DataSequenceNumber: seqPtr(UnassignedSequenceNumber),
		FileSequenceNumber: seqPtr(UnassignedSequenceNumber),
		DataFile:           NewDataFile("data/a.parquet", 0, nil),
	}, manifest)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.DataSequenceNumber != 4 || resolved.FileSequenceNumber != 4 {
		t.Fatalf("unassigned sequence did not inherit: %+v", resolved)
	}
}
