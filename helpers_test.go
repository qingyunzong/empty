package dataeng

import "testing"

func seqPtr(v int64) *int64 { return &v }
func idPtr(v int64) *int64  { return &v }

func mustPlan(t *testing.T, table *Table, snapshotID int64, filter any) *ScanPlan {
	t.Helper()
	plan, err := NewPlanner(table).Plan(snapshotID, filter)
	if err != nil {
		t.Fatalf("plan snapshot %d: %v", snapshotID, err)
	}
	return plan
}

func taskForPath(t *testing.T, plan *ScanPlan, path string) *FileScanTask {
	t.Helper()
	for _, task := range plan.Tasks {
		if task.DataFile.FilePath == path {
			return task
		}
	}
	t.Fatalf("task for %q not found in plan", path)
	return nil
}

func deletePaths(deletes []*BoundDeleteFile) []string {
	out := make([]string, 0, len(deletes))
	for _, d := range deletes {
		out = append(out, d.DataFile.FilePath)
	}
	return out
}

func containsPath(paths []string, want string) bool {
	for _, path := range paths {
		if path == want {
			return true
		}
	}
	return false
}

func specRegion() PartitionSpec {
	return PartitionSpec{
		SpecID: 0,
		Fields: []PartitionField{{
			SourceID:  1,
			FieldID:   1000,
			Name:      "region",
			Transform: TransformIdentity,
		}},
	}
}

func specByID() PartitionSpec {
	return PartitionSpec{
		SpecID: 1,
		Fields: []PartitionField{{
			SourceID:  2,
			FieldID:   1001,
			Name:      "id_bucket",
			Transform: "bucket[8]",
		}},
	}
}

func unpartitionedSpec() PartitionSpec {
	return PartitionSpec{SpecID: 2}
}
