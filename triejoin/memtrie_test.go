package triejoin

import (
	"context"
	"reflect"
	"testing"
)

func TestMemCursorSeekSemantics(t *testing.T) {
	snap := RelationSnapshot{
		ID:      "R",
		Columns: []string{"x", "y"},
		Tuples: [][]int64{
			{1, 10}, {1, 30}, {2, 20}, {5, 40}, {9, 50},
		},
	}
	c, err := MemFactory{}.NewIterator(snap)
	if err != nil {
		t.Fatal(err)
	}
	cur := c.(*MemCursor)

	if err := cur.Open(); err != nil {
		t.Fatal(err)
	}
	// Fresh level starts at the smallest value.
	if !cur.Valid() || cur.At() != 1 {
		t.Fatalf("initial position = %d, want 1", cur.At())
	}

	// Seek from the current position to the smallest value >= target.
	ok, err := cur.SeekTo(4)
	if err != nil || !ok || cur.At() != 5 {
		t.Fatalf("SeekTo(4) = %d %v %v, want 5", cur.At(), ok, err)
	}
	before := cur.Counts()
	if before.Nexts != 0 {
		t.Fatalf("seek must not use Next, counts=%+v", before)
	}

	// Seek to a value before the current position stays put.
	ok, _ = cur.SeekTo(2)
	if !ok || cur.At() != 5 {
		t.Fatalf("backward SeekTo must keep position, got %d", cur.At())
	}

	// Descend into the child level of the current value and come back Up;
	// Up restores the parent position.
	if err := cur.Open(); err != nil {
		t.Fatal(err)
	}
	if !cur.Valid() || cur.At() != 40 {
		t.Fatalf("child level first value = %d, want 40", cur.At())
	}
	ok, _ = cur.Next()
	if ok {
		t.Fatal("child of x=5 has only one value")
	}
	if err := cur.Up(); err != nil {
		t.Fatal(err)
	}
	if !cur.Valid() || cur.At() != 5 {
		t.Fatalf("Up must restore parent value, got %d", cur.At())
	}

	// Seek beyond the domain exhausts the level.
	ok, _ = cur.SeekTo(100)
	if ok || cur.Valid() {
		t.Fatal("SeekTo past the end must exhaust the level")
	}
	if err := cur.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestEightRelationsAndSingleEnumeration(t *testing.T) {
	vars := []string{"a", "b", "c", "d", "e", "f", "g", "h"}
	rels := make([]Relation, 8)
	for i, v := range vars {
		rels[i] = Relation{
			ID:      "rel-" + v,
			Columns: []string{v},
			Tuples:  [][]int64{{int64(i)}, {int64(i + 100)}},
		}
	}
	// Every variable has two independent values: 2^8 = 256 tuples, produced in
	// global lexicographic order without any Cartesian pre-materialization.
	it, err := Join(context.Background(), vars, rels)
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	got, counts, err := drain(it)
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	if len(got) != 256 {
		t.Fatalf("expected 256 tuples, got %d", len(got))
	}
	if !reflect.DeepEqual(got[0], []int64{0, 1, 2, 3, 4, 5, 6, 7}) {
		t.Fatalf("first tuple wrong: %v", got[0])
	}
	if !reflect.DeepEqual(got[255], []int64{100, 101, 102, 103, 104, 105, 106, 107}) {
		t.Fatalf("last tuple wrong: %v", got[255])
	}
	if counts.Opens != counts.Ups {
		t.Fatalf("open/up imbalance: %+v", counts)
	}
	// Single-cursor levels enumerate with Next; seek counters stay zero because
	// no level intersects multiple cursors.
	if counts.Seeks != 0 {
		t.Fatalf("unary-only join must not seek, counts=%+v", counts)
	}
}
