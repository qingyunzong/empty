package dataeng

import (
	"reflect"
	"testing"
)

func testCatalog(t *testing.T) *Catalog {
	t.Helper()
	snapshots := []Snapshot{
		{
			ID:             1,
			SequenceNumber: 1,
			DeleteFiles: []DeleteFile{{
				Path:           "s3://bucket/root-delete",
				SequenceNumber: 1,
				Records:        []PositionDelete{{FilePath: "s3://bucket/data", Position: 0}},
			}},
		},
		{
			ID:             2,
			ParentID:       1,
			SequenceNumber: 2,
			DeleteFiles: []DeleteFile{{
				Path:           "s3://bucket/main-delete",
				SequenceNumber: 2,
				Records:        []PositionDelete{{FilePath: "s3://bucket/data", Position: 1}},
			}},
		},
		{
			ID:             3,
			ParentID:       1,
			SequenceNumber: 2,
			DeleteFiles: []DeleteFile{{
				Path:           "s3://bucket/sibling-delete",
				SequenceNumber: 2,
				Records:        []PositionDelete{{FilePath: "s3://bucket/data", Position: 2}},
			}},
		},
		{
			ID:                 4,
			ParentID:           2,
			SequenceNumber:     3,
			RemovedDeleteFiles: []string{"s3://bucket/root-delete"},
			DeleteFiles: []DeleteFile{{
				Path:           "s3://bucket/main-tip-delete",
				SequenceNumber: 3,
				Records:        []PositionDelete{{FilePath: "s3://bucket/data", Position: 3}},
			}},
		},
	}
	catalog, err := NewCatalogWithBranches(snapshots, map[string]int64{
		"main":  4,
		"other": 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

func TestCatalogLineageAndBranchVisibility(t *testing.T) {
	catalog := testCatalog(t)
	snapshots, err := catalog.Lineage(4)
	if err != nil {
		t.Fatal(err)
	}
	if got := []int64{snapshots[0].ID, snapshots[1].ID, snapshots[2].ID}; !reflect.DeepEqual(got, []int64{1, 2, 4}) {
		t.Fatalf("lineage IDs = %v, want [1 2 4]", got)
	}

	tests := []struct {
		name     string
		snapshot int64
		want     []string
	}{
		{
			name:     "root",
			snapshot: 1,
			want:     []string{"s3://bucket/root-delete"},
		},
		{
			name:     "main branch before tombstone",
			snapshot: 2,
			want:     []string{"s3://bucket/main-delete", "s3://bucket/root-delete"},
		},
		{
			name:     "sibling branch",
			snapshot: 3,
			want:     []string{"s3://bucket/root-delete", "s3://bucket/sibling-delete"},
		},
		{
			name:     "main tip after tombstone",
			snapshot: 4,
			want:     []string{"s3://bucket/main-delete", "s3://bucket/main-tip-delete"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			files, err := catalog.VisibleDeleteFiles(test.snapshot)
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, file := range files {
				got = append(got, file.Path)
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("visible files = %v, want %v", got, test.want)
			}
		})
	}
}

func TestPlanSnapshotDoesNotInheritSiblingDeletes(t *testing.T) {
	catalog := testCatalog(t)
	dataFiles := []DataFile{{Path: "s3://bucket/data", SequenceNumber: 1}}

	mainPlan, err := catalog.PlanBranch("main", dataFiles)
	if err != nil {
		t.Fatal(err)
	}
	mainWant := []Interval{{Start: 1, End: 2}, {Start: 3, End: 4}}
	if !reflect.DeepEqual(mainPlan.Files[0].Intervals, mainWant) {
		t.Fatalf("main intervals = %+v, want %+v", mainPlan.Files[0].Intervals, mainWant)
	}

	otherPlan, err := catalog.PlanBranch("other", dataFiles)
	if err != nil {
		t.Fatal(err)
	}
	otherWant := []Interval{{Start: 0, End: 1}, {Start: 2, End: 3}}
	if !reflect.DeepEqual(otherPlan.Files[0].Intervals, otherWant) {
		t.Fatalf("other intervals = %+v, want %+v", otherPlan.Files[0].Intervals, otherWant)
	}
	if otherPlan.IsDeleted("s3://bucket/data", 1) {
		t.Fatal("other branch must not inherit main branch deletes")
	}
}

func TestVisibilityInheritsDeleteSequenceFromSnapshot(t *testing.T) {
	catalog, err := NewCatalog([]Snapshot{{
		ID:             9,
		SequenceNumber: 7,
		DeleteFiles: []DeleteFile{{
			Path:    "d",
			Records: []PositionDelete{{FilePath: "a", Position: 0}},
		}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	files, err := catalog.VisibleDeleteFiles(9)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0].SequenceNumber != 7 || files[0].SnapshotID != 9 {
		t.Fatalf("visible delete file = %+v, want inherited seq 7 and snapshot 9", files)
	}

	oldPlan, err := catalog.PlanSnapshot(9, []DataFile{{Path: "a", SequenceNumber: 7}})
	if err != nil {
		t.Fatal(err)
	}
	if !oldPlan.IsDeleted("a", 0) {
		t.Fatal("delete with inherited sequence 7 should apply to data sequence 7")
	}
	newPlan, err := catalog.PlanSnapshot(9, []DataFile{{Path: "a", SequenceNumber: 8}})
	if err != nil {
		t.Fatal(err)
	}
	if len(newPlan.Files) != 0 {
		t.Fatalf("delete with sequence 7 must not apply to data sequence 8: %+v", newPlan.Files)
	}
}

func TestRepeatedManifestEntryKeepsOriginalSequence(t *testing.T) {
	rootDelete := DeleteFile{
		Path: "d",
		Records: []PositionDelete{
			{FilePath: "a", Position: 0},
		},
	}
	catalog, err := NewCatalog([]Snapshot{
		{ID: 1, SequenceNumber: 1, DeleteFiles: []DeleteFile{rootDelete}},
		// Snapshot 2 repeats the inherited entry, as a full manifest listing
		// would, without repeating its sequence number.
		{ID: 2, ParentID: 1, SequenceNumber: 3, DeleteFiles: []DeleteFile{rootDelete}},
	})
	if err != nil {
		t.Fatal(err)
	}
	files, err := catalog.VisibleDeleteFiles(2)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0].SequenceNumber != 1 || files[0].SnapshotID != 1 {
		t.Fatalf("visible delete file = %+v, want original sequence 1 and snapshot 1", files)
	}

	plan, err := catalog.PlanSnapshot(2, []DataFile{{Path: "a", SequenceNumber: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if !plan.IsDeleted("a", 0) {
		t.Fatal("original delete sequence 1 should apply to data sequence 1")
	}
	newer, err := catalog.PlanSnapshot(2, []DataFile{{Path: "a", SequenceNumber: 2}})
	if err != nil {
		t.Fatal(err)
	}
	if len(newer.Files) != 0 {
		t.Fatalf("repeated manifest entry must not act like a new sequence-3 delete: %+v", newer.Files)
	}
}

func TestRemovedDeleteFileCanBecomeVisibleAgain(t *testing.T) {
	snapshots := []Snapshot{
		{ID: 1, SequenceNumber: 1, DeleteFiles: []DeleteFile{{
			Path: "d", SequenceNumber: 1,
			Records: []PositionDelete{{FilePath: "a", Position: 0}},
		}}},
		{ID: 2, ParentID: 1, SequenceNumber: 2, RemovedDeleteFiles: []string{"d"}},
		{ID: 3, ParentID: 2, SequenceNumber: 3, DeleteFiles: []DeleteFile{{
			Path: "d", SequenceNumber: 3,
			Records: []PositionDelete{{FilePath: "a", Position: 1}},
		}}},
	}
	catalog, err := NewCatalog(snapshots)
	if err != nil {
		t.Fatal(err)
	}
	if files, _ := catalog.VisibleDeleteFiles(2); len(files) != 0 {
		t.Fatalf("snapshot 2 visible files = %+v, want none", files)
	}
	files, err := catalog.VisibleDeleteFiles(3)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0].SequenceNumber != 3 {
		t.Fatalf("snapshot 3 visible files = %+v, want re-added file", files)
	}
}

func TestRemovalMatchesCanonicalDeletePath(t *testing.T) {
	catalog, err := NewCatalog([]Snapshot{
		{ID: 1, SequenceNumber: 1, DeleteFiles: []DeleteFile{{
			Path: "S3://Bucket/delete",
			Records: []PositionDelete{
				{FilePath: "a", Position: 0},
			},
		}}},
		{
			ID:                 2,
			ParentID:           1,
			SequenceNumber:     2,
			RemovedDeleteFiles: []string{"s3://bucket/delete"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	files, err := catalog.VisibleDeleteFiles(2)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Fatalf("canonical removal left files visible: %+v", files)
	}
}

func TestCatalogRejectsInvalidGraphs(t *testing.T) {
	tests := []struct {
		name      string
		snapshots []Snapshot
		branches  map[string]int64
	}{
		{
			name:      "zero snapshot ID",
			snapshots: []Snapshot{{ID: 0}},
		},
		{
			name:      "duplicate snapshot ID",
			snapshots: []Snapshot{{ID: 1}, {ID: 1}},
		},
		{
			name:      "missing parent",
			snapshots: []Snapshot{{ID: 1, ParentID: 2}},
		},
		{
			name:      "self parent",
			snapshots: []Snapshot{{ID: 1, ParentID: 1}},
		},
		{
			name: "parent cycle",
			snapshots: []Snapshot{
				{ID: 1, ParentID: 2, SequenceNumber: 2},
				{ID: 2, ParentID: 1, SequenceNumber: 2},
			},
		},
		{
			name: "sequence goes backwards",
			snapshots: []Snapshot{
				{ID: 1, SequenceNumber: 5},
				{ID: 2, ParentID: 1, SequenceNumber: 4},
			},
		},
		{
			name:      "negative sequence",
			snapshots: []Snapshot{{ID: 1, SequenceNumber: -1}},
		},
		{
			name:      "unknown branch head",
			snapshots: []Snapshot{{ID: 1}},
			branches:  map[string]int64{"main": 2},
		},
		{
			name:      "empty branch name",
			snapshots: []Snapshot{{ID: 1}},
			branches:  map[string]int64{"": 1},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NewCatalogWithBranches(test.snapshots, test.branches); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestCatalogUnknownLookups(t *testing.T) {
	catalog, err := NewCatalog([]Snapshot{{ID: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := catalog.Lineage(0); err == nil {
		t.Fatal("Lineage(0) should fail")
	}
	if _, err := catalog.Lineage(2); err == nil {
		t.Fatal("Lineage(unknown) should fail")
	}
	if _, err := catalog.VisibleDeleteFiles(2); err == nil {
		t.Fatal("VisibleDeleteFiles(unknown) should fail")
	}
	if _, err := catalog.PlanSnapshot(2, nil); err == nil {
		t.Fatal("PlanSnapshot(unknown) should fail")
	}
	if _, err := catalog.PlanBranch("missing", nil); err == nil {
		t.Fatal("PlanBranch(unknown) should fail")
	}
	if _, err := NewPlanner(nil).PlanSnapshot(1, nil); err == nil {
		t.Fatal("nil catalog planner should fail")
	}
}

func TestCatalogReturnsCopies(t *testing.T) {
	catalog, err := NewCatalog([]Snapshot{{
		ID: 1,
		DeleteFiles: []DeleteFile{{
			Path:    "d",
			Records: []PositionDelete{{FilePath: "a", Position: 0}},
		}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, _ := catalog.Snapshot(1)
	snapshot.DeleteFiles[0].Records[0].Position = 99
	again, _ := catalog.Snapshot(1)
	if again.DeleteFiles[0].Records[0].Position != 0 {
		t.Fatal("Catalog leaked a mutable snapshot")
	}
}
