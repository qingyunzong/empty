package triejoin

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

// TestPauseAtRecursionBoundaries pulls tuples one at a time with arbitrary
// pauses (including stopping immediately after a tuple emitted at the deepest
// level) and verifies no tuple is re-emitted and ordering is preserved.
func TestPauseAtRecursionBoundaries(t *testing.T) {
	vars := []string{"a", "b", "c"}
	rels := []Relation{
		{ID: "R", Columns: []string{"a", "b"}, Tuples: [][]int64{
			{1, 1}, {1, 2}, {2, 1}, {2, 2},
		}},
		{ID: "S", Columns: []string{"b", "c"}, Tuples: [][]int64{
			{1, 7}, {1, 8}, {2, 7}, {2, 8},
		}},
	}
	want := referenceJoin(vars, rels)

	it, err := Join(context.Background(), vars, rels)
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	var got [][]int64
	// Pause after every single tuple; resume across multiple calls.
	for i := 0; ; i++ {
		tup, ok, err := it.Next()
		if err != nil {
			t.Fatalf("Next %d: %v", i, err)
		}
		if !ok {
			break
		}
		got = append(got, tup)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("paused join mismatch\n got %v\nwant %v", got, want)
	}

	// Exhausted iterator stays exhausted and emits nothing further.
	if tup, ok, err := it.Next(); err != nil || ok || tup != nil {
		t.Fatalf("exhausted iterator must return (nil,false,nil), got %v %v %v", tup, ok, err)
	}
}

func TestDuplicateTuplesDeduplicated(t *testing.T) {
	vars := []string{"a", "b"}
	rels := []Relation{{ID: "R", Columns: []string{"a", "b"}, Tuples: [][]int64{
		{1, 2}, {1, 2}, {2, 3}, {2, 3}, {1, 2},
	}}}
	it, err := Join(context.Background(), vars, rels)
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	got, _, err := drain(it)
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	want := [][]int64{{1, 2}, {2, 3}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("dedup mismatch\n got %v\nwant %v", got, want)
	}
}

func TestValidationRejects(t *testing.T) {
	good := func() ([]string, []Relation) {
		return []string{"a", "b"}, []Relation{
			{ID: "R", Columns: []string{"a", "b"}, Tuples: [][]int64{{1, 2}}},
		}
	}

	cases := []struct {
		name string
		vars []string
		rels []Relation
	}{
		{"no relations", []string{"a"}, nil},
		{"too many relations", repeatVars("v", 9), nineRelations()},
		{"duplicate global var", []string{"a", "a"}, []Relation{
			{ID: "R", Columns: []string{"a"}, Tuples: [][]int64{{1}}},
		}},
		{"duplicate relation id", []string{"a"}, []Relation{
			{ID: "R", Columns: []string{"a"}, Tuples: [][]int64{{1}}},
			{ID: "R", Columns: []string{"a"}, Tuples: [][]int64{{1}}},
		}},
		{"duplicate column", []string{"a", "b"}, []Relation{
			{ID: "R", Columns: []string{"a", "a"}, Tuples: [][]int64{{1, 2}}},
		}},
		{"arity mismatch", []string{"a", "b"}, []Relation{
			{ID: "R", Columns: []string{"a", "b"}, Tuples: [][]int64{{1}}},
		}},
		{"unknown column", []string{"a"}, []Relation{
			{ID: "R", Columns: []string{"x"}, Tuples: [][]int64{{1}}},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Join(context.Background(), tc.vars, tc.rels); err == nil {
				t.Fatalf("expected rejection for %s", tc.name)
			}
		})
	}

	// Sanity: the good fixture itself is accepted.
	vars, rels := good()
	if _, err := Join(context.Background(), vars, rels); err != nil {
		t.Fatalf("good fixture rejected: %v", err)
	}
}

func repeatVars(prefix string, n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = string(rune('a' + i))
	}
	return out
}

func nineRelations() []Relation {
	rels := make([]Relation, 9)
	for i := range rels {
		col := string(rune('a' + i))
		rels[i] = Relation{ID: col, Columns: []string{col}, Tuples: [][]int64{{1}}}
	}
	return rels
}

func TestCountsExposedAndBalanced(t *testing.T) {
	vars := []string{"a", "b"}
	rels := []Relation{
		{ID: "A", Columns: []string{"a"}, Tuples: [][]int64{{1}, {2}, {3}}},
		{ID: "B", Columns: []string{"a", "b"}, Tuples: [][]int64{{1, 9}, {2, 9}}},
	}
	it, err := Join(context.Background(), vars, rels)
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	if _, _, err := drain(it); err != nil {
		t.Fatalf("drain: %v", err)
	}
	counts := it.Counts()
	if counts.Opens == 0 || counts.Ups == 0 {
		t.Fatalf("expected open/up activity, got %+v", counts)
	}
	// Every Open on a real trie level is matched by an Up when the frame closes.
	if counts.Opens != counts.Ups {
		t.Fatalf("unbalanced open/up counts: %+v", counts)
	}
	if counts.Seeks < 0 || counts.Nexts < 0 {
		t.Fatalf("negative counters: %+v", counts)
	}
}

func TestZeroArityCounters(t *testing.T) {
	vars := []string{"a"}
	unit := []Relation{
		{ID: "A", Columns: []string{"a"}, Tuples: [][]int64{{1}, {2}}},
		{ID: "unit", Columns: nil, Tuples: [][]int64{{}}},
	}
	it, err := Join(context.Background(), vars, unit)
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	if _, counts, err := drain(it); err != nil {
		t.Fatalf("drain: %v", err)
	} else if counts.Opens != counts.Ups {
		t.Fatalf("unit relation unbalanced counts: %+v", counts)
	}

	empty := []Relation{
		{ID: "A", Columns: []string{"a"}, Tuples: [][]int64{{1}}},
		{ID: "empty", Columns: nil, Tuples: nil},
	}
	it, err = Join(context.Background(), vars, empty)
	if err != nil {
		t.Fatalf("Join empty: %v", err)
	}
	if got, _, err := drain(it); err != nil || len(got) != 0 {
		t.Fatalf("empty zero-arity join: rows=%v err=%v", got, err)
	}
	// Empty result short-circuits before any cursor navigation.
	if counts := it.Counts(); counts != (Counts{}) {
		t.Fatalf("empty join must report zero cursor operations, got %+v", counts)
	}
}

func TestSnapshotImmutability(t *testing.T) {
	vars := []string{"a", "b"}
	rels := []Relation{{ID: "R", Columns: []string{"a", "b"}, Tuples: [][]int64{
		{1, 2}, {2, 3},
	}}}
	it, err := Join(context.Background(), vars, rels)
	if err != nil {
		t.Fatalf("Join: %v", err)
	}

	// Mutate the caller-owned inputs after the iterator exists.
	rels[0].Tuples[0][0] = 999
	rels[0].Tuples = append(rels[0].Tuples, []int64{123, 456})
	rels[0].Columns[0] = "mutated"

	got, _, err := drain(it)
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	want := [][]int64{{1, 2}, {2, 3}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("iterator observed post-construction mutation:\n got %v\nwant %v", got, want)
	}
}

func TestCancelClosesAllCursors(t *testing.T) {
	vars := []string{"a"}
	rels := []Relation{{ID: "A", Columns: []string{"a"}, Tuples: [][]int64{{1}, {2}}}}

	t.Run("explicit close", func(t *testing.T) {
		it, err := Join(context.Background(), vars, rels)
		if err != nil {
			t.Fatalf("Join: %v", err)
		}
		if _, ok, err := it.Next(); err != nil || !ok {
			t.Fatalf("first Next: %v %v", ok, err)
		}
		if err := it.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}
		if _, ok, err := it.Next(); !errors.Is(err, ErrIteratorClosed) || ok {
			t.Fatalf("read after close must fail with ErrIteratorClosed, got ok=%v err=%v", ok, err)
		}
		// Close stays idempotent.
		if err := it.Close(); err != nil {
			t.Fatalf("second Close: %v", err)
		}
	})

	t.Run("context cancel", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		it, err := Join(ctx, vars, rels)
		if err != nil {
			t.Fatalf("Join: %v", err)
		}
		cancel()
		if _, ok, _ := it.Next(); ok {
			t.Fatal("cancelled context must stop iteration")
		}
		if _, _, err := it.Next(); err == nil {
			t.Fatal("further reads after cancellation must error")
		}
	})
}
