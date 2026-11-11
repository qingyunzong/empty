package q159

import (
	"context"
	"errors"
	"testing"
)

func edgeIDs(path []Edge) []EdgeID {
	ids := make([]EdgeID, len(path))
	for i, e := range path {
		ids[i] = e.ID
	}
	return ids
}

func assertIDs(t *testing.T, tr *Transformer, src, dst SchemaID, want []EdgeID) {
	t.Helper()
	path, err := currentSnapshot(tr).route(src, dst)
	if err != nil {
		t.Fatalf("route %s->%s: %v", src, dst, err)
	}
	got := edgeIDs(path)
	if len(got) != len(want) {
		t.Fatalf("route %s->%s = %v, want %v", src, dst, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("route %s->%s = %v, want %v", src, dst, got, want)
		}
	}
}

// Cheapest total cost wins regardless of hop count.
func TestCheapestPathByTotalCost(t *testing.T) {
	edges := []Edge{
		tagEdge("direct", "a", "d", 5),
		tagEdge("e1", "a", "b", 1),
		tagEdge("e2", "b", "c", 1),
		tagEdge("e3", "c", "d", 1),
	}
	tr, err := New(edges, "d")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	assertIDs(t, tr, "a", "d", []EdgeID{"e1", "e2", "e3"})

	out, err := tr.ApplyBatch(context.Background(), []Record{{Schema: "a", Payload: "v"}})
	if err != nil {
		t.Fatalf("ApplyBatch: %v", err)
	}
	if got := out[0].Payload.(string); got != "e3>e2>e1>v" {
		t.Fatalf("payload = %q, want path e1->e2->e3 applied in order", got)
	}

	// Once the direct edge is cheaper it wins.
	edges[0].Cost = 2
	tr2, err := New(edges, "d")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	assertIDs(t, tr2, "a", "d", []EdgeID{"direct"})
}

// Equal total cost is broken by lexicographic edge ID sequence, comparing
// element by element rather than by path length.
func TestTieBreaksOnEdgeIDLexicographic(t *testing.T) {
	edges := []Edge{
		tagEdge("a1", "s", "m", 2),
		tagEdge("a2", "m", "t", 2), // seq [a1,a2], cost 4
		tagEdge("b1", "s", "n", 2),
		tagEdge("b2", "n", "t", 2), // seq [b1,b2], cost 4
		tagEdge("z", "s", "t", 4),  // seq [z],    cost 4
	}
	tr, err := New(edges, "t")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	assertIDs(t, tr, "s", "t", []EdgeID{"a1", "a2"})

	// Remove the winner; the next lexicographic sequence takes over.
	edges = edges[1:]
	tr, err = New(edges, "t")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	assertIDs(t, tr, "s", "t", []EdgeID{"b1", "b2"})

	// A single-edge sequence [z] loses to [b1,b2] because z > b1 at the
	// first position, even though it is shorter.
	edges = []Edge{
		tagEdge("b1", "s", "n", 2),
		tagEdge("b2", "n", "t", 2), // seq [b1,b2], cost 4
		tagEdge("z", "s", "t", 4),  // seq [z],    cost 4
	}
	tr, err = New(edges, "t")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	assertIDs(t, tr, "s", "t", []EdgeID{"b1", "b2"})
}

// A failure from any edge rejects the entire batch and later records are
// never transformed.
func TestTransformFailureRejectsBatch(t *testing.T) {
	calls := 0
	counting := func(e Edge) Edge {
		inner := e.Apply
		e.Apply = func(ctx context.Context, in any) (any, error) {
			calls++
			return inner(ctx, in)
		}
		return e
	}
	edges := []Edge{
		counting(failEdge("bad", "a", "b", 1)),
		counting(incEdge("e2", "b", "c", 1)),
	}
	tr, err := New(edges, "c")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	out, err := tr.ApplyBatch(context.Background(), []Record{
		{Schema: "a", Payload: 1},
		{Schema: "a", Payload: 2},
	})
	if !errors.Is(err, errBoom) {
		t.Fatalf("err = %v, want errBoom wrapped", err)
	}
	if out != nil {
		t.Fatalf("out = %v, want nil", out)
	}
	if calls != 1 {
		t.Fatalf("transform calls = %d, want 1 (second record must not run)", calls)
	}
}

func TestSameSchemaIsEmptyPath(t *testing.T) {
	tr, err := New([]Edge{incEdge("e1", "a", "b", 1)}, "a")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	out, err := tr.ApplyBatch(context.Background(), []Record{{Schema: "a", Payload: 42}})
	if err != nil {
		t.Fatalf("ApplyBatch: %v", err)
	}
	if out[0].Schema != "a" || out[0].Payload != 42 {
		t.Fatalf("output = %+v, want untouched payload", out)
	}
}

func TestEdgeValidation(t *testing.T) {
	good := incEdge("e1", "a", "b", 1)
	badCost := good
	badCost.Cost = 0
	if _, err := New([]Edge{badCost}, "b"); !errors.Is(err, ErrInvalidEdge) {
		t.Fatalf("zero cost err = %v, want ErrInvalidEdge", err)
	}

	badFn := good
	badFn.Apply = nil
	if _, err := New([]Edge{badFn}, "b"); !errors.Is(err, ErrInvalidEdge) {
		t.Fatalf("nil Apply err = %v, want ErrInvalidEdge", err)
	}

	if _, err := New([]Edge{good, good}, "b"); !errors.Is(err, ErrDuplicateEdge) {
		t.Fatalf("duplicate err = %v, want ErrDuplicateEdge", err)
	}

	if _, err := New(nil, ""); err == nil {
		t.Fatal("empty target must fail")
	}
	tr, err := New(nil, "a")
	if err != nil {
		t.Fatalf("empty graph: %v", err)
	}
	if err := tr.SetTarget(""); err == nil {
		t.Fatal("SetTarget empty must fail")
	}
}
