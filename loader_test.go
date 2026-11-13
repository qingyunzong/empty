package dataeng

import (
	"errors"
	"testing"
)

func TestPlannerUsesManifestListLoaderWithoutMutatingTable(t *testing.T) {
	table := NewTable()
	table.AddPartitionSpec(unpartitionedSpec())
	table.AddSnapshot(Snapshot{
		SnapshotID:     10,
		SequenceNumber: 4,
		ManifestList:   "metadata/snap-10.avro",
	})
	if err := table.SetCurrentSnapshot(10); err != nil {
		t.Fatal(err)
	}

	listLoader := ManifestListLoaderFunc(func(snapshot Snapshot) ([]ManifestFile, error) {
		if snapshot.SnapshotID != 10 {
			t.Fatalf("loader got snapshot %d", snapshot.SnapshotID)
		}
		return []ManifestFile{{
			ManifestPath:    "metadata/data.avro",
			PartitionSpecID: 2,
			Content:         ManifestContentData,
			SequenceNumber:  4,
			AddedSnapshotID: idPtr(10),
			Entries: []ManifestEntry{{
				Status:   EntryStatusAdded,
				DataFile: NewDataFile("data/a.parquet", 2, nil),
			}},
		}}, nil
	})

	plan, err := NewPlanner(table, listLoader).PlanCurrent(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Tasks) != 1 || plan.Tasks[0].DataSequenceNumber != 4 {
		t.Fatalf("unexpected plan: %+v", plan.Tasks)
	}
	snapshot, _ := table.Snapshot(10)
	if len(snapshot.Manifests) != 0 {
		t.Fatal("planner mutated the table's snapshot manifest list")
	}
}

func TestPlannerRequiresLoaderForUnloadedManifest(t *testing.T) {
	table := NewTable()
	table.AddSnapshot(Snapshot{
		SnapshotID:     1,
		SequenceNumber: 1,
		Manifests: []ManifestFile{{
			ManifestPath:    "metadata/data.avro",
			PartitionSpecID: 0,
			SequenceNumber:  1,
			AddedFiles:      1,
		}},
	})
	if err := table.SetCurrentSnapshot(1); err != nil {
		t.Fatal(err)
	}
	_, err := NewPlanner(table).PlanCurrent(nil)
	if !errors.Is(err, ErrManifestLoaderRequired) {
		t.Fatalf("want ErrManifestLoaderRequired, got %v", err)
	}
}

func TestManifestLoaderIsUsed(t *testing.T) {
	table := NewTable()
	table.AddSnapshot(Snapshot{
		SnapshotID:     1,
		SequenceNumber: 1,
		Manifests: []ManifestFile{{
			ManifestPath:    "metadata/data.avro",
			PartitionSpecID: 0,
			SequenceNumber:  1,
		}},
	})
	if err := table.SetCurrentSnapshot(1); err != nil {
		t.Fatal(err)
	}
	loader := ManifestLoaderFunc(func(manifest ManifestFile) ([]ManifestEntry, error) {
		if manifest.ManifestPath != "metadata/data.avro" {
			t.Fatalf("unexpected manifest %q", manifest.ManifestPath)
		}
		return []ManifestEntry{{
			Status:   EntryStatusAdded,
			DataFile: NewDataFile("data/loaded.parquet", 0, nil),
		}}, nil
	})
	plan, err := NewPlanner(table, loader).PlanCurrent(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Tasks) != 1 || plan.Tasks[0].DataFile.FilePath != "data/loaded.parquet" {
		t.Fatalf("loader result not used: %+v", plan.Tasks)
	}
}

func TestSnapshotLineageDetectsCyclesAndMissingParents(t *testing.T) {
	cycle := NewTable()
	cycle.AddSnapshot(Snapshot{SnapshotID: 1, ParentSnapshotID: idPtr(2), SequenceNumber: 1})
	cycle.AddSnapshot(Snapshot{SnapshotID: 2, ParentSnapshotID: idPtr(1), SequenceNumber: 2})
	if _, err := cycle.Lineage(1); !errors.Is(err, ErrBrokenLineage) {
		t.Fatalf("want cycle error, got %v", err)
	}

	missing := NewTable()
	missing.AddSnapshot(Snapshot{SnapshotID: 1, ParentSnapshotID: idPtr(99), SequenceNumber: 1})
	if _, err := missing.Lineage(1); !errors.Is(err, ErrBrokenLineage) {
		t.Fatalf("want missing-parent error, got %v", err)
	}
}
