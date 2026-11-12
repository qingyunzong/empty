package triejoin

import (
	"context"
	"math"
	"reflect"
	"testing"
)

// TestCyclicTriangle covers a cyclic 3-ary-style triangle query R(a,b),
// S(b,c), T(a,c): every variable appears in two relations and no pairwise
// intermediate relation may be materialized.
func TestCyclicTriangle(t *testing.T) {
	vars := []string{"a", "b", "c"}
	rels := []Relation{
		{ID: "R", Columns: []string{"a", "b"}, Tuples: [][]int64{
			{1, 2}, {1, 3}, {2, 3}, {3, 4},
		}},
		{ID: "S", Columns: []string{"b", "c"}, Tuples: [][]int64{
			{2, 10}, {3, 10}, {3, 11}, {4, 12},
		}},
		{ID: "T", Columns: []string{"a", "c"}, Tuples: [][]int64{
			{1, 10}, {2, 10}, {2, 11}, {3, 12},
		}},
	}
	want := referenceJoin(vars, rels)

	it, err := Join(context.Background(), vars, rels)
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	got, _, err := drain(it)
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("triangle join mismatch\n got %v\nwant %v", got, want)
	}
}

// TestColumnOrderDifferent feeds relations whose columns are not declared in
// global order; the engine must restrict and reorder them itself.
func TestColumnOrderDifferent(t *testing.T) {
	vars := []string{"x", "y", "z"}
	rels := []Relation{
		{ID: "backward", Columns: []string{"z", "y", "x"}, Tuples: [][]int64{
			{30, 2, 1}, {31, 3, 1}, {30, 4, 2},
		}},
		{ID: "forward", Columns: []string{"x", "y"}, Tuples: [][]int64{
			{1, 2}, {1, 3}, {2, 4},
		}},
		{ID: "zonly", Columns: []string{"z"}, Tuples: [][]int64{{30}, {31}, {99}}},
	}
	want := referenceJoin(vars, rels)

	it, err := Join(context.Background(), vars, rels)
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	got, _, err := drain(it)
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("reordered join mismatch\n got %v\nwant %v", got, want)
	}
	if len(want) == 0 {
		t.Fatal("test setup expects at least one result")
	}
}

// TestVariableInSingleRelation keeps a variable bound by exactly one relation,
// exercising single-cursor levels and nested enumeration.
func TestVariableInSingleRelation(t *testing.T) {
	vars := []string{"a", "d"}
	rels := []Relation{
		{ID: "A", Columns: []string{"a"}, Tuples: [][]int64{{1}, {2}, {3}}},
		{ID: "D", Columns: []string{"d"}, Tuples: [][]int64{{7}, {8}}},
	}
	want := referenceJoin(vars, rels)
	it, err := Join(context.Background(), vars, rels)
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	got, _, err := drain(it)
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("cross product mismatch\n got %v\nwant %v", got, want)
	}
}

func TestEmptyAndUnitRelations(t *testing.T) {
	vars := []string{"a", "b"}
	base := []Relation{
		{ID: "A", Columns: []string{"a"}, Tuples: [][]int64{{1}, {2}}},
		{ID: "B", Columns: []string{"b"}, Tuples: [][]int64{{9}}},
	}

	// A zero-arity unit relation {()} does not restrict the join.
	unit := append(append([]Relation{}, base...),
		Relation{ID: "unit", Columns: nil, Tuples: [][]int64{{}}})
	it, err := Join(context.Background(), vars, unit)
	if err != nil {
		t.Fatalf("Join unit: %v", err)
	}
	got, _, err := drain(it)
	if err != nil {
		t.Fatalf("drain unit: %v", err)
	}
	if want := referenceJoin(vars, unit); !reflect.DeepEqual(got, want) {
		t.Fatalf("unit relation mismatch\n got %v\nwant %v", got, want)
	}

	// An empty zero-arity relation makes the whole result empty.
	empty := append(append([]Relation{}, base...),
		Relation{ID: "empty0", Columns: nil, Tuples: nil})
	it, err = Join(context.Background(), vars, empty)
	if err != nil {
		t.Fatalf("Join empty0: %v", err)
	}
	got, _, err = drain(it)
	if err != nil {
		t.Fatalf("drain empty0: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("empty zero-arity relation must yield no tuples, got %v", got)
	}

	// An ordinary empty relation behaves the same way.
	emptyRel := append(append([]Relation{}, base...),
		Relation{ID: "emptyN", Columns: []string{"a", "b"}, Tuples: nil})
	it, err = Join(context.Background(), vars, emptyRel)
	if err != nil {
		t.Fatalf("Join emptyN: %v", err)
	}
	got, _, err = drain(it)
	if err != nil {
		t.Fatalf("drain emptyN: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("empty relation must yield no tuples, got %v", got)
	}
}

func TestInt64Endpoints(t *testing.T) {
	vars := []string{"a", "b"}
	min := int64(math.MinInt64)
	max := int64(math.MaxInt64)
	rels := []Relation{
		{ID: "A", Columns: []string{"a"}, Tuples: [][]int64{{min}, {-1}, {0}, {1}, {max}}},
		{ID: "B", Columns: []string{"a", "b"}, Tuples: [][]int64{
			{min, min}, {0, max}, {max, min}, {max, max},
		}},
	}
	want := referenceJoin(vars, rels)
	it, err := Join(context.Background(), vars, rels)
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	got, _, err := drain(it)
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("endpoint join mismatch\n got %v\nwant %v", got, want)
	}
	// Sorted lexicographically with signed ordering: MinInt64 first.
	if got[0][0] != min || got[len(got)-1][0] != max {
		t.Fatalf("signed ordering broken: %v", got)
	}
}
