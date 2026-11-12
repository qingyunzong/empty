package dataeng_test

import (
	"errors"
	"math"
	"testing"

	dataeng "example.org/dataeng/q0188"
)

type key = string
type pid = string
type cid = string

func newChecker() *dataeng.Checker[key, pid, cid] {
	return dataeng.New[key, pid, cid]()
}

func ptr(k key) *key { return &k }

func iv(s, e int64) dataeng.Interval { return dataeng.Interval{Start: s, End: e} }

func parent(id, k string, s, e int64) dataeng.ParentRecord[key, pid] {
	return dataeng.ParentRecord[key, pid]{RecordID: id, Key: k, Valid: iv(s, e)}
}

func child(id string, ref *key, s, e int64) dataeng.ChildRecord[key, cid] {
	return dataeng.ChildRecord[key, cid]{RecordID: id, Ref: ref, Valid: iv(s, e)}
}

func assertIntervals(t *testing.T, label string, got, want []dataeng.Interval) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: got %v, want %v", label, got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("%s[%d]: got %v, want %v", label, i, got, want)
		}
	}
}

func TestGapsBasic(t *testing.T) {
	c := newChecker()
	if err := c.AddParents([]dataeng.ParentRecord[key, pid]{
		parent("p1", "k1", 0, 10),
		parent("p2", "k1", 10, 20),
		parent("p3", "k1", 15, 30),
	}); err != nil {
		t.Fatalf("add parents: %v", err)
	}
	if err := c.AddChildren([]dataeng.ChildRecord[key, cid]{
		child("c1", ptr("k1"), 0, 40),
		child("c2", ptr("k1"), 5, 25),
		child("c3", ptr("k1"), 0, 30),
		child("c4", ptr("missing"), 0, 10),
		child("c5", nil, 0, 10),
	}); err != nil {
		t.Fatalf("add children: %v", err)
	}

	cases := []struct {
		id   cid
		want []dataeng.Interval
	}{
		{"c1", []dataeng.Interval{iv(30, 40)}},
		{"c2", nil},
		{"c3", nil},
		{"c4", []dataeng.Interval{iv(0, 10)}},
		{"c5", nil},
	}
	for _, tc := range cases {
		got, err := c.Gaps(tc.id)
		if err != nil {
			t.Fatalf("Gaps(%s): %v", tc.id, err)
		}
		assertIntervals(t, tc.id, got, tc.want)
	}

	if _, err := c.Gaps("nope"); !errors.Is(err, dataeng.ErrChildNotFound) {
		t.Fatalf("expected ErrChildNotFound, got %v", err)
	}
	if err := c.Verify(); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

func TestGapsMultipleDisjoint(t *testing.T) {
	c := newChecker()
	if err := c.AddParents([]dataeng.ParentRecord[key, pid]{
		parent("p1", "k", 10, 20),
		parent("p2", "k", 30, 40),
	}); err != nil {
		t.Fatal(err)
	}
	if err := c.AddChildren([]dataeng.ChildRecord[key, cid]{
		child("c", ptr("k"), 0, 50),
	}); err != nil {
		t.Fatal(err)
	}
	want := []dataeng.Interval{iv(0, 10), iv(20, 30), iv(40, 50)}
	got, err := c.Gaps("c")
	if err != nil {
		t.Fatal(err)
	}
	assertIntervals(t, "c", got, want)
	if err := c.Verify(); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

func TestAdjacentParentsMerge(t *testing.T) {
	c := newChecker()
	if err := c.AddParents([]dataeng.ParentRecord[key, pid]{
		parent("p1", "k", 0, 5),
		parent("p2", "k", 5, 10),
		parent("p3", "k", 10, 15),
	}); err != nil {
		t.Fatal(err)
	}
	if err := c.AddChildren([]dataeng.ChildRecord[key, cid]{
		child("c", ptr("k"), 0, 15),
	}); err != nil {
		t.Fatal(err)
	}
	got, err := c.Gaps("c")
	if err != nil {
		t.Fatal(err)
	}
	assertIntervals(t, "adjacent", got, nil)
}

func TestEmptyIntervals(t *testing.T) {
	c := newChecker()
	if err := c.AddParents([]dataeng.ParentRecord[key, pid]{
		parent("p", "k", 5, 5),
	}); err != nil {
		t.Fatalf("empty parent interval must be accepted: %v", err)
	}
	if err := c.AddChildren([]dataeng.ChildRecord[key, cid]{
		child("c", ptr("k"), 7, 7),
	}); err != nil {
		t.Fatalf("empty child interval must be accepted: %v", err)
	}
	got, err := c.Gaps("c")
	if err != nil {
		t.Fatal(err)
	}
	assertIntervals(t, "empty", got, nil)
	all := c.AllGaps()
	if g, ok := all["c"]; !ok || g != nil {
		t.Fatalf("AllGaps empty child = %v, want nil", g)
	}
}

func TestReverseIntervalRejected(t *testing.T) {
	c := newChecker()
	err := c.AddParents([]dataeng.ParentRecord[key, pid]{
		parent("ok", "k", 0, 1),
		parent("bad", "k", 9, 3),
	})
	if !errors.Is(err, dataeng.ErrReverseInterval) {
		t.Fatalf("expected ErrReverseInterval, got %v", err)
	}
	if err := c.AddChildren([]dataeng.ChildRecord[key, cid]{
		child("bad", ptr("k"), 5, 1),
	}); !errors.Is(err, dataeng.ErrReverseInterval) {
		t.Fatalf("expected ErrReverseInterval, got %v", err)
	}
}

func TestDuplicateAddRejected(t *testing.T) {
	c := newChecker()
	if err := c.AddParents([]dataeng.ParentRecord[key, pid]{parent("p", "k", 0, 1)}); err != nil {
		t.Fatal(err)
	}
	err := c.AddParents([]dataeng.ParentRecord[key, pid]{parent("p", "k", 2, 3)})
	if !errors.Is(err, dataeng.ErrDuplicateID) {
		t.Fatalf("existing id: expected ErrDuplicateID, got %v", err)
	}
	err = c.AddParents([]dataeng.ParentRecord[key, pid]{
		parent("x", "k", 0, 1),
		parent("x", "k", 2, 3),
	})
	if !errors.Is(err, dataeng.ErrDuplicateID) {
		t.Fatalf("in-batch dup: expected ErrDuplicateID, got %v", err)
	}

	if err := c.AddChildren([]dataeng.ChildRecord[key, cid]{child("c", nil, 0, 1)}); err != nil {
		t.Fatal(err)
	}
	err = c.AddChildren([]dataeng.ChildRecord[key, cid]{
		child("a", ptr("k"), 0, 1),
		child("a", ptr("k"), 2, 3),
	})
	if !errors.Is(err, dataeng.ErrDuplicateID) {
		t.Fatalf("child dup: expected ErrDuplicateID, got %v", err)
	}
	if _, err := c.Gaps("a"); !errors.Is(err, dataeng.ErrChildNotFound) {
		t.Fatalf("atomic child add failed, got %v", err)
	}
}

func TestDeleteMissingRejected(t *testing.T) {
	c := newChecker()
	if err := c.AddParents([]dataeng.ParentRecord[key, pid]{parent("p", "k", 0, 10)}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.DeleteParents([]pid{"p", "ghost"}); !errors.Is(err, dataeng.ErrMissingID) {
		t.Fatalf("expected ErrMissingID, got %v", err)
	}
	if _, err := c.DeleteParents([]pid{"p", "p"}); !errors.Is(err, dataeng.ErrDuplicateID) {
		t.Fatalf("in-batch duplicate delete: expected ErrDuplicateID, got %v", err)
	}
	if err := c.AddChildren([]dataeng.ChildRecord[key, cid]{child("c", ptr("k"), 0, 10)}); err != nil {
		t.Fatal(err)
	}
	got, _ := c.Gaps("c")
	assertIntervals(t, "still covered", got, nil)

	if err := c.DeleteChildren([]cid{"ghost"}); !errors.Is(err, dataeng.ErrMissingID) {
		t.Fatalf("child missing: expected ErrMissingID, got %v", err)
	}
}

func TestDeleteParentsReport(t *testing.T) {
	c := newChecker()
	if err := c.AddParents([]dataeng.ParentRecord[key, pid]{
		parent("p1", "k", 0, 10),
		parent("p2", "k", 10, 20),
		parent("p3", "other", 0, 20),
	}); err != nil {
		t.Fatal(err)
	}
	if err := c.AddChildren([]dataeng.ChildRecord[key, cid]{
		child("c1", ptr("k"), 0, 20),
		child("c2", ptr("k"), 0, 10),
		child("c3", ptr("other"), 0, 20),
		child("c4", nil, 0, 20),
	}); err != nil {
		t.Fatal(err)
	}

	report, err := c.DeleteParents([]pid{"p2"})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.DeletedParentIDs) != 1 || report.DeletedParentIDs[0] != "p2" {
		t.Fatalf("deleted ids = %v", report.DeletedParentIDs)
	}
	if len(report.Affected) != 1 {
		t.Fatalf("affected = %d (%v), want 1", len(report.Affected), report.Affected)
	}
	chg := report.Affected[0]
	if chg.ChildID != "c1" {
		t.Fatalf("affected child = %s, want c1", chg.ChildID)
	}
	assertIntervals(t, "c1 before", chg.Before, nil)
	assertIntervals(t, "c1 after", chg.After, []dataeng.Interval{iv(10, 20)})
	assertIntervals(t, "c1 net", chg.NetNew, []dataeng.Interval{iv(10, 20)})

	report2, err := c.DeleteParents([]pid{"p1"})
	if err != nil {
		t.Fatal(err)
	}
	changes2 := map[cid]dataeng.ChildGapChange[cid]{}
	for _, chg := range report2.Affected {
		changes2[chg.ChildID] = chg
	}
	if len(changes2) != 2 {
		t.Fatalf("report2 affected = %d (%v), want 2", len(changes2), report2.Affected)
	}
	chg2 := changes2["c1"]
	assertIntervals(t, "c1 after2", chg2.After, []dataeng.Interval{iv(0, 20)})
	assertIntervals(t, "c1 net2", chg2.NetNew, []dataeng.Interval{iv(0, 10)})
	chg3 := changes2["c2"]
	assertIntervals(t, "c2 before2", chg3.Before, nil)
	assertIntervals(t, "c2 after2", chg3.After, []dataeng.Interval{iv(0, 10)})
	assertIntervals(t, "c2 net2", chg3.NetNew, []dataeng.Interval{iv(0, 10)})

	if err := c.DeleteChildren([]cid{"c4"}); err != nil {
		t.Fatalf("delete child: %v", err)
	}
	if _, err := c.Gaps("c4"); !errors.Is(err, dataeng.ErrChildNotFound) {
		t.Fatalf("c4 should be gone, got %v", err)
	}
	if err := c.Verify(); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

func TestNullRefExempt(t *testing.T) {
	c := newChecker()
	if err := c.AddChildren([]dataeng.ChildRecord[key, cid]{
		child("n1", nil, math.MinInt64, math.MaxInt64),
	}); err != nil {
		t.Fatal(err)
	}
	got, err := c.Gaps("n1")
	if err != nil {
		t.Fatal(err)
	}
	assertIntervals(t, "null ref", got, nil)
	if err := c.Verify(); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

func TestInt64Extrema(t *testing.T) {
	minI := int64(math.MinInt64)
	maxI := int64(math.MaxInt64)
	c := newChecker()
	if err := c.AddParents([]dataeng.ParentRecord[key, pid]{
		parent("p1", "k", minI, 0),
		parent("p2", "k", 0, maxI),
	}); err != nil {
		t.Fatal(err)
	}
	if err := c.AddChildren([]dataeng.ChildRecord[key, cid]{
		child("full", ptr("k"), minI, maxI),
		child("tail", ptr("k"), maxI-3, maxI),
		child("bare", ptr("nope"), minI, maxI),
	}); err != nil {
		t.Fatal(err)
	}
	got, _ := c.Gaps("full")
	assertIntervals(t, "full extrema", got, nil)
	got, _ = c.Gaps("tail")
	assertIntervals(t, "tail extrema", got, nil)
	got, _ = c.Gaps("bare")
	assertIntervals(t, "bare extrema", got, []dataeng.Interval{iv(minI, maxI)})
	if err := c.Verify(); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

func TestAllGapsAndOrder(t *testing.T) {
	c := newChecker()
	if err := c.AddParents([]dataeng.ParentRecord[key, pid]{
		parent("p", "k", 2, 8),
	}); err != nil {
		t.Fatal(err)
	}
	if err := c.AddChildren([]dataeng.ChildRecord[key, cid]{
		child("z", ptr("k"), 0, 10),
		child("a", ptr("k"), 0, 5),
		child("m", nil, 0, 10),
	}); err != nil {
		t.Fatal(err)
	}
	all := c.AllGaps()
	assertIntervals(t, "z", all["z"], []dataeng.Interval{iv(0, 2), iv(8, 10)})
	assertIntervals(t, "a", all["a"], []dataeng.Interval{iv(0, 2)})
	if g := all["m"]; g != nil {
		t.Fatalf("null ref gap = %v, want nil", g)
	}

	if err := c.DeleteChildren([]cid{"a"}); err != nil {
		t.Fatal(err)
	}
	all = c.AllGaps()
	if _, ok := all["a"]; ok {
		t.Fatal("deleted child still present in AllGaps")
	}
	if err := c.Verify(); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

func TestEmptyBatchAndErrorAs(t *testing.T) {
	c := newChecker()
	if err := c.AddParents(nil); err != nil {
		t.Fatalf("empty add parents: %v", err)
	}
	if err := c.AddChildren(nil); err != nil {
		t.Fatalf("empty add children: %v", err)
	}
	if _, err := c.DeleteParents(nil); err != nil {
		t.Fatalf("empty delete parents: %v", err)
	}
	if err := c.DeleteChildren(nil); err != nil {
		t.Fatalf("empty delete children: %v", err)
	}

	err := c.AddParents([]dataeng.ParentRecord[key, pid]{
		parent("dup1", "k", 1, 2),
		parent("dup1", "k", 3, 4),
	})
	var be *dataeng.BatchError
	if !errors.As(err, &be) {
		t.Fatalf("expected *BatchError, got %T %v", err, err)
	}
	if be.Kind != dataeng.KindDuplicateID || len(be.IDs) != 1 || be.IDs[0] != "dup1" {
		t.Fatalf("batch error detail = %+v", be)
	}
}
