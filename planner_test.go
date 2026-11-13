package dataeng

import "testing"

func partitionedTable() *Table {
	table := NewTable()
	table.AddPartitionSpec(specRegion())
	table.AddPartitionSpec(specByID())
	table.AddPartitionSpec(unpartitionedSpec())

	dataManifest := ManifestFile{
		ManifestPath:    "metadata/data-1.avro",
		PartitionSpecID: 0,
		Content:         ManifestContentData,
		SequenceNumber:  1,
		AddedSnapshotID: idPtr(1),
		Entries: []ManifestEntry{
			{
				Status:   EntryStatusAdded,
				DataFile: NewDataFile("data/us-1.parquet", 0, Partition{"region": "us"}),
			},
			{
				Status:   EntryStatusAdded,
				DataFile: NewDataFile("data/eu-1.parquet", 0, Partition{"region": "eu"}),
			},
		},
	}
	deleteManifest := ManifestFile{
		ManifestPath:    "metadata/delete-2.avro",
		PartitionSpecID: 0,
		Content:         ManifestContentDeletes,
		SequenceNumber:  2,
		AddedSnapshotID: idPtr(2),
		Entries: []ManifestEntry{
			{
				Status:   EntryStatusAdded,
				DataFile: NewPositionDeleteFile("deletes/us-pos.parquet", "", 0, Partition{"region": "us"}),
			},
			{
				Status:   EntryStatusAdded,
				DataFile: NewEqualityDeleteFile("deletes/eu-eq.parquet", []int{1}, 0, Partition{"region": "eu"}),
			},
		},
	}

	table.AddSnapshot(Snapshot{
		SnapshotID:     1,
		SequenceNumber: 1,
		TimestampMs:    100,
		Manifests:      []ManifestFile{dataManifest},
	})
	table.AddSnapshot(Snapshot{
		SnapshotID:       2,
		ParentSnapshotID: idPtr(1),
		SequenceNumber:   2,
		TimestampMs:      200,
		Manifests:        []ManifestFile{dataManifest, deleteManifest},
	})
	if err := table.SetCurrentSnapshot(2); err != nil {
		panic(err)
	}
	return table
}

func TestPlanPrunesDataFilesButKeepsDeleteCandidates(t *testing.T) {
	table := partitionedTable()
	usPlan := mustPlan(t, table, 2, PartitionEquals("region", "us"))
	if len(usPlan.Tasks) != 1 || usPlan.Tasks[0].DataFile.FilePath != "data/us-1.parquet" {
		t.Fatalf("unexpected us plan: %+v", usPlan.DataFiles)
	}
	task := taskForPath(t, usPlan, "data/us-1.parquet")
	if !containsPath(deletePaths(task.DeleteFiles), "deletes/us-pos.parquet") {
		t.Fatalf("us position delete missing: %v", deletePaths(task.DeleteFiles))
	}
	if containsPath(deletePaths(task.DeleteFiles), "deletes/eu-eq.parquet") {
		t.Fatalf("eu equality delete wrongly bound to us data: %v", deletePaths(task.DeleteFiles))
	}
	if len(usPlan.DeleteFiles) != 2 {
		t.Fatalf("live delete candidates must not be predicate-pruned: %v", deletePaths(usPlan.DeleteFiles))
	}
	if !containsPath(deletePaths(usPlan.UnboundDeleteFiles), "deletes/eu-eq.parquet") {
		t.Fatalf("eu delete should remain visible as unbound, got %v", deletePaths(usPlan.UnboundDeleteFiles))
	}

	euPlan := mustPlan(t, table, 2, PartitionEquals("region", "eu"))
	if len(euPlan.Tasks) != 1 || euPlan.Tasks[0].DataFile.FilePath != "data/eu-1.parquet" {
		t.Fatalf("unexpected eu plan: %+v", euPlan.DataFiles)
	}
	euTask := taskForPath(t, euPlan, "data/eu-1.parquet")
	if !containsPath(deletePaths(euTask.DeleteFiles), "deletes/eu-eq.parquet") {
		t.Fatalf("eu equality delete missing: %v", deletePaths(euTask.DeleteFiles))
	}
	if len(euPlan.DeleteFiles) != 2 {
		t.Fatalf("filtered plan lost delete candidates: %v", deletePaths(euPlan.DeleteFiles))
	}
}

func TestPlanBindsSameCommitPositionButNotEqualityDelete(t *testing.T) {
	table := partitionedTable()
	sameCommitData := ManifestFile{
		ManifestPath:    "metadata/data-3.avro",
		PartitionSpecID: 0,
		Content:         ManifestContentData,
		SequenceNumber:  3,
		AddedSnapshotID: idPtr(3),
		Entries: []ManifestEntry{{
			Status:   EntryStatusAdded,
			DataFile: NewDataFile("data/us-3.parquet", 0, Partition{"region": "us"}),
		}},
	}
	sameCommitDelete := ManifestFile{
		ManifestPath:    "metadata/delete-3.avro",
		PartitionSpecID: 0,
		Content:         ManifestContentDeletes,
		SequenceNumber:  3,
		AddedSnapshotID: idPtr(3),
		Entries: []ManifestEntry{
			{
				Status:   EntryStatusAdded,
				DataFile: NewPositionDeleteFile("deletes/us-pos-3.parquet", "", 0, Partition{"region": "us"}),
			},
			{
				Status:   EntryStatusAdded,
				DataFile: NewEqualityDeleteFile("deletes/us-eq-3.parquet", []int{1}, 0, Partition{"region": "us"}),
			},
		},
	}
	s2, _ := table.Snapshot(2)
	table.AddSnapshot(Snapshot{
		SnapshotID:       3,
		ParentSnapshotID: idPtr(2),
		SequenceNumber:   3,
		TimestampMs:      300,
		Manifests:        append(append([]ManifestFile{}, s2.Manifests...), sameCommitData, sameCommitDelete),
	})
	if err := table.SetCurrentSnapshot(3); err != nil {
		t.Fatal(err)
	}

	plan := mustPlan(t, table, 3, PartitionEquals("region", "us"))
	oldTask := taskForPath(t, plan, "data/us-1.parquet")
	if !containsPath(deletePaths(oldTask.DeleteFiles), "deletes/us-pos-3.parquet") ||
		!containsPath(deletePaths(oldTask.DeleteFiles), "deletes/us-eq-3.parquet") {
		t.Fatalf("same-commit deletes missing from older data: %v", deletePaths(oldTask.DeleteFiles))
	}
	newTask := taskForPath(t, plan, "data/us-3.parquet")
	if !containsPath(deletePaths(newTask.DeleteFiles), "deletes/us-pos-3.parquet") {
		t.Fatalf("position delete in same commit must apply: %v", deletePaths(newTask.DeleteFiles))
	}
	if containsPath(deletePaths(newTask.DeleteFiles), "deletes/us-eq-3.parquet") {
		t.Fatalf("equality delete in same commit must not apply: %v", deletePaths(newTask.DeleteFiles))
	}
	if err := plan.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestPlanKeepsDeletesFromDifferentPartitionSpecs(t *testing.T) {
	table := NewTable()
	table.AddPartitionSpec(specRegion())
	table.AddPartitionSpec(specByID())
	table.AddPartitionSpec(unpartitionedSpec())

	dataManifest := ManifestFile{
		ManifestPath:    "metadata/data-1.avro",
		PartitionSpecID: 0,
		Content:         ManifestContentData,
		SequenceNumber:  1,
		AddedSnapshotID: idPtr(1),
		Entries: []ManifestEntry{{
			Status:   EntryStatusAdded,
			DataFile: NewDataFile("data/us-1.parquet", 0, Partition{"region": "us"}),
		}},
	}
	bucketedDelete := ManifestFile{
		ManifestPath:    "metadata/delete-bucket.avro",
		PartitionSpecID: 1,
		Content:         ManifestContentDeletes,
		SequenceNumber:  2,
		AddedSnapshotID: idPtr(2),
		Entries: []ManifestEntry{{
			Status:   EntryStatusAdded,
			DataFile: NewPositionDeleteFile("deletes/bucket-pos.parquet", "", 1, Partition{"id_bucket": 3}),
		}},
	}
	globalEquality := ManifestFile{
		ManifestPath:    "metadata/delete-global.avro",
		PartitionSpecID: 2,
		Content:         ManifestContentDeletes,
		SequenceNumber:  2,
		AddedSnapshotID: idPtr(2),
		Entries: []ManifestEntry{{
			Status:   EntryStatusAdded,
			DataFile: NewEqualityDeleteFile("deletes/global-eq.parquet", []int{1}, 2, nil),
		}},
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
		Manifests:        []ManifestFile{dataManifest, bucketedDelete, globalEquality},
	})
	if err := table.SetCurrentSnapshot(2); err != nil {
		t.Fatal(err)
	}

	plan := mustPlan(t, table, 2, PartitionEquals("region", "us"))
	task := taskForPath(t, plan, "data/us-1.parquet")
	if !containsPath(deletePaths(task.DeleteFiles), "deletes/bucket-pos.parquet") {
		t.Fatalf("cross-spec position delete was lost: %v", deletePaths(task.DeleteFiles))
	}
	if !containsPath(deletePaths(task.DeleteFiles), "deletes/global-eq.parquet") {
		t.Fatalf("global equality delete was lost: %v", deletePaths(task.DeleteFiles))
	}

	if !DeleteMayMatchData(
		NewDataFile("data/us-1.parquet", 0, Partition{"region": "us"}), &table.PartitionSpecs[0],
		NewPositionDeleteFile("deletes/bucket-pos.parquet", "", 1, Partition{"id_bucket": 3}), &table.PartitionSpecs[1],
	) {
		t.Fatal("different partition layouts must default to may-match")
	}
	if !DeleteMayMatchData(
		NewDataFile("data/us-1.parquet", 0, Partition{"region": "us"}), &table.PartitionSpecs[0],
		NewEqualityDeleteFile("deletes/global-eq.parquet", []int{1}, 2, nil), &table.PartitionSpecs[2],
	) {
		t.Fatal("unpartitioned equality delete must be global")
	}
	if DeleteMayMatchData(
		NewDataFile("data/us-1.parquet", 0, Partition{"region": "us"}), &table.PartitionSpecs[0],
		NewPositionDeleteFile("deletes/eu-pos.parquet", "", 0, Partition{"region": "eu"}), &table.PartitionSpecs[0],
	) {
		t.Fatal("same-spec delete in another partition must not bind")
	}
}

func TestFileScopedDeleteUsesReferencedPath(t *testing.T) {
	table := NewTable()
	table.AddPartitionSpec(specRegion())
	dataManifest := ManifestFile{
		ManifestPath:    "metadata/data.avro",
		PartitionSpecID: 0,
		Content:         ManifestContentData,
		SequenceNumber:  1,
		AddedSnapshotID: idPtr(1),
		Entries: []ManifestEntry{
			{Status: EntryStatusAdded, DataFile: NewDataFile("data/us.parquet", 0, Partition{"region": "us"})},
			{Status: EntryStatusAdded, DataFile: NewDataFile("data/eu.parquet", 0, Partition{"region": "eu"})},
		},
	}
	deleteManifest := ManifestFile{
		ManifestPath:    "metadata/delete.avro",
		PartitionSpecID: 0,
		Content:         ManifestContentDeletes,
		SequenceNumber:  2,
		AddedSnapshotID: idPtr(2),
		Entries: []ManifestEntry{{
			Status: EntryStatusAdded,
			DataFile: NewPositionDeleteFile(
				"deletes/file-scoped.parquet", "data/us.parquet", 0,
				Partition{"region": "eu"}), // partition metadata must not override the reference
		}},
	}
	table.AddSnapshot(Snapshot{SnapshotID: 1, SequenceNumber: 1, Manifests: []ManifestFile{dataManifest}})
	table.AddSnapshot(Snapshot{
		SnapshotID: 2, ParentSnapshotID: idPtr(1), SequenceNumber: 2,
		Manifests: []ManifestFile{dataManifest, deleteManifest},
	})
	if err := table.SetCurrentSnapshot(2); err != nil {
		t.Fatal(err)
	}

	plan := mustPlan(t, table, 2, nil)
	usTask := taskForPath(t, plan, "data/us.parquet")
	if !containsPath(deletePaths(usTask.DeleteFiles), "deletes/file-scoped.parquet") {
		t.Fatalf("file-scoped delete missing from target: %v", deletePaths(usTask.DeleteFiles))
	}
	euTask := taskForPath(t, plan, "data/eu.parquet")
	if containsPath(deletePaths(euTask.DeleteFiles), "deletes/file-scoped.parquet") {
		t.Fatalf("file-scoped delete bound to non-target: %v", deletePaths(euTask.DeleteFiles))
	}
}

func TestRollbackDoesNotReuseFutureDeletes(t *testing.T) {
	table := partitionedTable()
	if err := table.RollbackToSnapshot(1); err != nil {
		t.Fatal(err)
	}
	currentPlan := mustPlan(t, table, 0, nil)
	if currentPlan.SnapshotID != 1 {
		t.Fatalf("rollback did not select snapshot 1: %d", currentPlan.SnapshotID)
	}
	if len(currentPlan.DeleteFiles) != 0 {
		t.Fatalf("rolled-back plan reused future deletes: %v", deletePaths(currentPlan.DeleteFiles))
	}
	for _, task := range currentPlan.Tasks {
		if task.HasDeletes() {
			t.Fatalf("rolled-back task has deletes: %v", deletePaths(task.DeleteFiles))
		}
	}

	futurePlan := mustPlan(t, table, 2, nil)
	if len(futurePlan.DeleteFiles) != 2 {
		t.Fatalf("explicit time travel to snapshot 2 should see its deletes: %v",
			deletePaths(futurePlan.DeleteFiles))
	}

	// Even if a caller accidentally merges a descendant manifest into the old
	// snapshot's manifest list, the lineage guard must reject it.
	s1, _ := table.Snapshot(1)
	leaky := *s1
	s2, _ := table.Snapshot(2)
	leaky.Manifests = append(append([]ManifestFile{}, s1.Manifests...), s2.Manifests[len(s2.Manifests)-1])
	leakyTable := NewTable()
	leakyTable.AddPartitionSpec(specRegion())
	leakyTable.AddSnapshot(leaky)
	leakyTable.AddSnapshot(*s2)
	if err := leakyTable.SetCurrentSnapshot(1); err != nil {
		t.Fatal(err)
	}
	leakyPlan := mustPlan(t, leakyTable, 1, nil)
	if len(leakyPlan.DeleteFiles) != 0 {
		t.Fatalf("descendant manifest leaked through rollback: %v", deletePaths(leakyPlan.DeleteFiles))
	}
}

func TestRollbackToTimestamp(t *testing.T) {
	table := partitionedTable()
	if err := table.RollbackToTimestamp(150); err != nil {
		t.Fatal(err)
	}
	current, ok := table.Current()
	if !ok || current.SnapshotID != 1 {
		t.Fatalf("timestamp rollback selected %+v", current)
	}
}
