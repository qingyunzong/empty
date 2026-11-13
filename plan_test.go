package dataeng

import (
	"reflect"
	"testing"
)

func TestPlanDeletesFiltersBySequenceAndCoalescesIntervals(t *testing.T) {
	dataFiles := []DataFile{
		{Path: "s3://bucket/a.parquet", SequenceNumber: 5},
		{Path: "s3://bucket/b.parquet", SequenceNumber: 5},
	}
	deleteFiles := []DeleteFile{
		{
			Path:           "s3://bucket/delete-old.parquet",
			SequenceNumber: 4,
			Records: []PositionDelete{
				{FilePath: "s3://bucket/a.parquet", Position: 0},
				{FilePath: "s3://bucket/a.parquet", Position: 1},
			},
		},
		{
			Path:           "s3://bucket/delete-a.parquet",
			SequenceNumber: 5,
			Records: []PositionDelete{
				{FilePath: "s3://bucket/a.parquet", Position: 1},
				{FilePath: "s3://bucket/a.parquet", Position: 2},
				{FilePath: "s3://bucket/a.parquet", Position: 2},
				{FilePath: "s3://bucket/a.parquet", Position: 4},
			},
		},
		{
			Path:           "s3://bucket/delete-new.parquet",
			SequenceNumber: 6,
			Records: []PositionDelete{
				{FilePath: "s3://bucket/a.parquet", Position: 3},
				{FilePath: "s3://bucket/a.parquet", Position: 6},
				{FilePath: "s3://bucket/b.parquet", Position: 0},
			},
		},
		{
			Path:           "s3://bucket/delete-b.parquet",
			SequenceNumber: 5,
			Records: []PositionDelete{
				{FilePath: "s3://bucket/b.parquet", Position: 1},
			},
		},
	}

	plan, err := PlanDeletes(dataFiles, deleteFiles)
	if err != nil {
		t.Fatal(err)
	}
	if plan.SnapshotID != 0 {
		t.Fatalf("SnapshotID = %d, want 0", plan.SnapshotID)
	}
	if len(plan.Files) != 2 {
		t.Fatalf("got %d file groups, want 2: %+v", len(plan.Files), plan.Files)
	}

	a := plan.Files[0]
	if a.Path != "s3://bucket/a.parquet" {
		t.Fatalf("first file = %q", a.Path)
	}
	wantA := []Interval{{Start: 1, End: 5}, {Start: 6, End: 7}}
	if !reflect.DeepEqual(a.Intervals, wantA) {
		t.Fatalf("A intervals = %+v, want %+v", a.Intervals, wantA)
	}
	if a.DeletedCount() != 5 {
		t.Fatalf("A deleted count = %d, want 5", a.DeletedCount())
	}
	if !a.IsDeleted(3) || a.IsDeleted(5) || !a.IsDeleted(6) || a.IsDeleted(7) {
		t.Fatalf("A interval membership is wrong: %+v", a.Intervals)
	}
	wantSources := []string{"s3://bucket/delete-a.parquet", "s3://bucket/delete-new.parquet"}
	if !reflect.DeepEqual(a.DeleteFiles, wantSources) {
		t.Fatalf("A sources = %v, want %v", a.DeleteFiles, wantSources)
	}

	b := plan.Files[1]
	wantB := []Interval{{Start: 0, End: 2}}
	if !reflect.DeepEqual(b.Intervals, wantB) {
		t.Fatalf("B intervals = %+v, want %+v", b.Intervals, wantB)
	}
	if plan.DeletedCount() != 7 {
		t.Fatalf("plan deleted count = %d, want 7", plan.DeletedCount())
	}
}

func TestPlanDeletesExcludesNewerDataFiles(t *testing.T) {
	dataFiles := []DataFile{
		{Path: "a", SequenceNumber: 7},
		{Path: "b", SequenceNumber: 8},
	}
	deletes := []DeleteFile{{
		Path:           "d",
		SequenceNumber: 7,
		Records: []PositionDelete{
			{FilePath: "a", Position: 0},
			{FilePath: "b", Position: 0},
		},
	}}
	plan, err := PlanDeletes(dataFiles, deletes)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Files) != 1 || plan.Files[0].Path != "a" {
		t.Fatalf("plan = %+v, want only a", plan.Files)
	}
}

func TestPlanDeletesIgnoresDataFilesOutsideTheScan(t *testing.T) {
	deletes := []DeleteFile{{
		Path:           "d",
		SequenceNumber: 2,
		Records: []PositionDelete{
			{FilePath: "not-in-scan", Position: 0},
		},
	}}
	plan, err := PlanDeletes([]DataFile{{Path: "in-scan", SequenceNumber: 1}}, deletes)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Files) != 0 {
		t.Fatalf("plan = %+v, want no groups", plan.Files)
	}
}

func TestPlanDeletesPathIdentity(t *testing.T) {
	dataFiles := []DataFile{{Path: "s3://bucket/data", SequenceNumber: 1}}
	deletes := []DeleteFile{{
		Path:           "d",
		SequenceNumber: 2,
		Records: []PositionDelete{
			{FilePath: "s3://bucket/data/", Position: 0},
			{FilePath: "s3://bucket//data", Position: 1},
			{FilePath: "s3://bucket/data%2F", Position: 2},
			{FilePath: "S3://BUCKET/data", Position: 3},
		},
	}}
	plan, err := PlanDeletes(dataFiles, deletes)
	if err != nil {
		t.Fatal(err)
	}
	want := []Interval{{Start: 3, End: 4}}
	if len(plan.Files) != 1 || !reflect.DeepEqual(plan.Files[0].Intervals, want) {
		t.Fatalf("plan = %+v, want intervals %+v", plan.Files, want)
	}
}

func TestPlanDeletesWithEmptyDataFiles(t *testing.T) {
	dataFiles := []DataFile{
		{Path: "b", SequenceNumber: 1, RowCount: 3},
		{Path: "a", SequenceNumber: 1},
	}
	deletes := []DeleteFile{{
		Path:           "d",
		SequenceNumber: 1,
		Records:        []PositionDelete{{FilePath: "b", Position: 2}},
	}}
	plan, err := PlanDeletes(dataFiles, deletes, WithEmptyDataFiles())
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Files) != 2 {
		t.Fatalf("got %d groups, want 2", len(plan.Files))
	}
	if plan.Files[0].Path != "a" || len(plan.Files[0].Intervals) != 0 {
		t.Fatalf("first group = %+v, want empty group for a", plan.Files[0])
	}
	if plan.Files[1].RowCount != 3 {
		t.Fatalf("RowCount not preserved: %+v", plan.Files[1])
	}
}

func TestPlanDeletesDeduplicatesIdenticalDataFiles(t *testing.T) {
	dataFiles := []DataFile{
		{Path: "S3://Bucket/a", SequenceNumber: 1},
		{Path: "s3://bucket/a", SequenceNumber: 1},
	}
	deletes := []DeleteFile{{
		Path:           "d",
		SequenceNumber: 1,
		Records:        []PositionDelete{{FilePath: "s3://bucket/a", Position: 0}},
	}}
	plan, err := PlanDeletes(dataFiles, deletes)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Files) != 1 {
		t.Fatalf("got %d groups, want 1", len(plan.Files))
	}
}

func TestCoalescePositions(t *testing.T) {
	got := coalescePositions([]int64{8, 0, 1, 2, 7, 5, 7})
	want := []Interval{{Start: 0, End: 3}, {Start: 5, End: 6}, {Start: 7, End: 9}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("coalescePositions() = %+v, want %+v", got, want)
	}
	if coalescePositions(nil) != nil {
		t.Fatal("expected nil intervals for no positions")
	}
}

func TestPlanRejectsInvalidInput(t *testing.T) {
	validData := []DataFile{{Path: "a", SequenceNumber: 1}}
	tests := []struct {
		name   string
		data   []DataFile
		delete []DeleteFile
	}{
		{
			name:   "negative data sequence",
			data:   []DataFile{{Path: "a", SequenceNumber: -1}},
			delete: nil,
		},
		{
			name:   "empty data path",
			data:   []DataFile{{Path: "", SequenceNumber: 1}},
			delete: nil,
		},
		{
			name:   "negative delete sequence",
			data:   validData,
			delete: []DeleteFile{{Path: "d", SequenceNumber: -1}},
		},
		{
			name: "empty record path",
			data: validData,
			delete: []DeleteFile{{
				Path: "d", SequenceNumber: 1,
				Records: []PositionDelete{{FilePath: "", Position: 0}},
			}},
		},
		{
			name: "negative position",
			data: validData,
			delete: []DeleteFile{{
				Path: "d", SequenceNumber: 1,
				Records: []PositionDelete{{FilePath: "a", Position: -1}},
			}},
		},
		{
			name: "unrepresentable position",
			data: validData,
			delete: []DeleteFile{{
				Path: "d", SequenceNumber: 1,
				Records: []PositionDelete{{FilePath: "a", Position: 1<<63 - 1}},
			}},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := PlanDeletes(test.data, test.delete); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}
