package dataeng

import (
	"reflect"
	"testing"
)

func testRows() []FileRows {
	return []FileRows{
		{
			DataFile: DataFile{Path: "s3://bucket/a", SequenceNumber: 5},
			Rows: []Row{
				{"a0"}, {"a1"}, {"a2"}, {"a3"}, {"a4"}, {"a5"},
			},
		},
		{
			DataFile: DataFile{Path: "s3://bucket/b", SequenceNumber: 5},
			Rows: []Row{
				{"b0"}, {"b1"}, {"b2"}, {"b3"},
			},
		},
	}
}

func testDeletes() []DeleteFile {
	return []DeleteFile{
		{
			Path:           "s3://bucket/old",
			SequenceNumber: 4,
			Records: []PositionDelete{
				{FilePath: "s3://bucket/a", Position: 5},
			},
		},
		{
			Path:           "s3://bucket/d1",
			SequenceNumber: 5,
			Records: []PositionDelete{
				{FilePath: "s3://bucket/a", Position: 0},
				{FilePath: "s3://bucket/a", Position: 2},
				{FilePath: "s3://bucket/a", Position: 3},
				{FilePath: "s3://bucket/b", Position: 1},
			},
		},
	}
}

func TestReferenceVisibleIsRowByRow(t *testing.T) {
	result, err := ReferenceVisible(testRows(), testDeletes())
	if err != nil {
		t.Fatal(err)
	}
	want := [][]Row{
		{{"a1"}, {"a4"}, {"a5"}},
		{{"b0"}, {"b2"}, {"b3"}},
	}
	for i := range want {
		if !reflect.DeepEqual(result.Files[i].Rows, want[i]) {
			t.Fatalf("file %d rows = %v, want %v", i, result.Files[i].Rows, want[i])
		}
	}
}

func TestPlanVisibleRowsMatchesReference(t *testing.T) {
	rows := testRows()
	deletes := testDeletes()
	plan, err := PlanDeletes(
		[]DataFile{rows[0].DataFile, rows[1].DataFile},
		deletes,
	)
	if err != nil {
		t.Fatal(err)
	}
	got, err := plan.VisibleRows(rows)
	if err != nil {
		t.Fatal(err)
	}
	want, err := ReferenceVisible(rows, deletes)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("plan visible rows = %#v, want %#v", got, want)
	}
	if err := VerifyPlan(plan, rows, deletes); err != nil {
		t.Fatalf("VerifyPlan() = %v", err)
	}
}

func TestVerifyPlanDetectsCorruption(t *testing.T) {
	rows := testRows()
	deletes := testDeletes()
	plan, err := PlanDeletes(
		[]DataFile{rows[0].DataFile, rows[1].DataFile},
		deletes,
	)
	if err != nil {
		t.Fatal(err)
	}
	plan.Files[0].Intervals = []Interval{{Start: 0, End: 1}}
	if err := VerifyPlan(plan, rows, deletes); err == nil {
		t.Fatal("expected verification to detect the missing delete interval")
	}
}

func TestOutOfRangeDeleteDoesNotChangeVisibleRows(t *testing.T) {
	rows := []FileRows{{
		DataFile: DataFile{Path: "a", SequenceNumber: 1},
		Rows:     []Row{{"0"}, {"1"}},
	}}
	deletes := []DeleteFile{{
		Path:           "d",
		SequenceNumber: 1,
		Records:        []PositionDelete{{FilePath: "a", Position: 99}},
	}}
	plan, err := PlanDeletes([]DataFile{rows[0].DataFile}, deletes)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyPlan(plan, rows, deletes); err != nil {
		t.Fatalf("out-of-range delete should not change visible records: %v", err)
	}
}

func TestCatalogReferenceAndVerification(t *testing.T) {
	catalog := testCatalog(t)
	rows := []FileRows{{
		DataFile: DataFile{Path: "s3://bucket/data", SequenceNumber: 1},
		Rows: []Row{
			{"0"}, {"1"}, {"2"}, {"3"}, {"4"},
		},
	}}
	plan, err := catalog.PlanSnapshot(4, []DataFile{rows[0].DataFile})
	if err != nil {
		t.Fatal(err)
	}
	if err := catalog.VerifySnapshotPlan(4, plan, rows); err != nil {
		t.Fatal(err)
	}
	visible, err := catalog.ReferenceVisibleAt(4, rows)
	if err != nil {
		t.Fatal(err)
	}
	want := []Row{{"0"}, {"2"}, {"4"}}
	if !reflect.DeepEqual(visible.Files[0].Rows, want) {
		t.Fatalf("visible rows = %v, want %v", visible.Files[0].Rows, want)
	}
}
