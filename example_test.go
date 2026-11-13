package dataeng_test

import (
	"fmt"

	"example.org/dataeng/q0037"
)

func ExamplePlanner_PlanCurrent() {
	table := dataeng.NewTable()
	table.AddPartitionSpec(dataeng.PartitionSpec{
		SpecID: 0,
		Fields: []dataeng.PartitionField{{
			SourceID: 1, FieldID: 1000, Name: "region",
			Transform: dataeng.TransformIdentity,
		}},
	})
	dataManifest := dataeng.ManifestFile{
		ManifestPath:    "metadata/data.avro",
		PartitionSpecID: 0,
		Content:         dataeng.ManifestContentData,
		SequenceNumber:  1,
		AddedSnapshotID: ptrInt64(1),
		Entries: []dataeng.ManifestEntry{{
			Status: dataeng.EntryStatusAdded,
			DataFile: dataeng.NewDataFile("data/us.parquet", 0,
				dataeng.Partition{"region": "us"}),
		}},
	}
	deleteManifest := dataeng.ManifestFile{
		ManifestPath:    "metadata/delete.avro",
		PartitionSpecID: 0,
		Content:         dataeng.ManifestContentDeletes,
		SequenceNumber:  2,
		AddedSnapshotID: ptrInt64(2),
		Entries: []dataeng.ManifestEntry{{
			Status: dataeng.EntryStatusAdded,
			DataFile: dataeng.NewPositionDeleteFile("deletes/us-pos.parquet", "", 0,
				dataeng.Partition{"region": "us"}),
		}},
	}
	table.AddSnapshot(dataeng.Snapshot{
		SnapshotID: 1, SequenceNumber: 1, Manifests: []dataeng.ManifestFile{dataManifest},
	})
	table.AddSnapshot(dataeng.Snapshot{
		SnapshotID: 2, ParentSnapshotID: ptrInt64(1), SequenceNumber: 2,
		Manifests: []dataeng.ManifestFile{dataManifest, deleteManifest},
	})
	_ = table.SetCurrentSnapshot(2)

	plan, err := dataeng.NewPlanner(table).
		PlanCurrent(dataeng.PartitionEquals("region", "us"))
	if err != nil {
		panic(err)
	}
	task := plan.Tasks[0]
	fmt.Printf("tasks=%d data=%s deletes=%d first=%s\n",
		len(plan.Tasks), task.DataFile.FilePath, len(task.DeleteFiles),
		task.DeleteFiles[0].DataFile.FilePath)

	// Output:
	// tasks=1 data=data/us.parquet deletes=1 first=deletes/us-pos.parquet
}

func ptrInt64(v int64) *int64 { return &v }
