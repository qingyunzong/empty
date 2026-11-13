package dataeng

import (
	"errors"
	"reflect"
	"testing"
)

func TestGraphReportsMissingParentsAndLateObservations(t *testing.T) {
	graph, err := NewShardGraph(
		Shard{ShardID: "child", ParentShardID: "parent", AdjacentParentShardID: "adjacent"},
	)
	if err != nil {
		t.Fatalf("NewShardGraph: %v", err)
	}
	missing := graph.MissingParents()
	if len(missing) != 2 {
		t.Fatalf("missing parents = %v, want two", missing)
	}
	if missing[0].ParentID != "adjacent" || missing[1].ParentID != "parent" {
		t.Fatalf("missing parent order = %v", missing)
	}

	if err := graph.Add(Shard{ShardID: "parent", EndingSequenceNumber: "10"}); err != nil {
		t.Fatalf("Add parent: %v", err)
	}
	if got := graph.MissingParents(); len(got) != 1 || got[0].ParentID != "adjacent" {
		t.Fatalf("missing parents after parent = %v", got)
	}
	if children := graph.Children("adjacent"); !reflect.DeepEqual(children, []ShardID{"child"}) {
		t.Fatalf("children of referenced but absent parent = %v, want [child]", children)
	}
}

func TestGraphRefinesOpenShardToClosed(t *testing.T) {
	graph, err := NewShardGraph(Shard{
		ShardID:                "shard",
		StartingSequenceNumber: "1",
	})
	if err != nil {
		t.Fatalf("NewShardGraph: %v", err)
	}
	if err := graph.Add(Shard{
		ShardID:                "shard",
		StartingSequenceNumber: "1",
		EndingSequenceNumber:   "9",
	}); err != nil {
		t.Fatalf("Add closed observation: %v", err)
	}
	shard, ok := graph.Shard("shard")
	if !ok || !shard.Closed() || shard.EndingSequenceNumber != "9" {
		t.Fatalf("shard = %+v, want closed at 9", shard)
	}
}

func TestGraphRejectsConflictingDuplicates(t *testing.T) {
	graph, err := NewShardGraph(Shard{ShardID: "child", ParentShardID: "one"})
	if err != nil {
		t.Fatalf("NewShardGraph: %v", err)
	}
	err = graph.Add(Shard{ShardID: "child", ParentShardID: "two"})
	if !errors.Is(err, ErrShardConflict) {
		t.Fatalf("conflicting add = %v, want ErrShardConflict", err)
	}
	if _, ok := graph.Shard("child"); !ok {
		t.Fatal("conflicting add removed existing shard")
	}
}

func TestGraphRejectsCycles(t *testing.T) {
	graph, err := NewShardGraph(Shard{ShardID: "a", ParentShardID: "b"})
	if err != nil {
		t.Fatalf("NewShardGraph: %v", err)
	}
	err = graph.Add(Shard{ShardID: "b", ParentShardID: "a"})
	if !errors.Is(err, ErrShardCycle) {
		t.Fatalf("cycle add = %v, want ErrShardCycle", err)
	}
	if graph.Has("b") {
		t.Fatal("failed cycle observation was retained")
	}
}

func TestShardParentsDeduplicate(t *testing.T) {
	shard := Shard{
		ShardID:               "child",
		ParentShardID:         "same",
		AdjacentParentShardID: "same",
	}
	got := shard.ParentIDs()
	if !reflect.DeepEqual(got, []ShardID{"same"}) {
		t.Fatalf("ParentIDs = %v", got)
	}
}

func TestSequenceNumberComparison(t *testing.T) {
	cases := []struct {
		left, right SequenceNumber
		want        int
		ok          bool
	}{
		{"9", "10", -1, true},
		{"100000000000000000000", "99999999999999999999", 1, true},
		{"seq-9", "seq-10", -1, true},
		{"abc", "abc", 0, true},
		{"abc", "def", 0, false},
	}
	for _, tc := range cases {
		got, ok := tc.left.Compare(tc.right)
		if got != tc.want || ok != tc.ok {
			t.Fatalf("%q.Compare(%q) = (%d, %t), want (%d, %t)",
				tc.left, tc.right, got, ok, tc.want, tc.ok)
		}
	}
}
