package depimpact

import (
	"container/heap"
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

func buildGraph(t *testing.T, nodes []string, edges [][2]string) *Graph {
	t.Helper()
	g := NewGraph()
	for _, n := range nodes {
		g.AddNode(n)
	}
	for _, e := range edges {
		g.AddEdge(e[0], e[1])
	}
	return g
}

func impactMap(impacts []Impact) map[string]Impact {
	m := make(map[string]Impact, len(impacts))
	for _, imp := range impacts {
		m[imp.Test] = imp
	}
	return m
}

func TestAnalyzeLinearChain(t *testing.T) {
	// app depends on lib, lib depends on util; test_app depends on app.
	g := buildGraph(t, nil, [][2]string{
		{"app", "lib"},
		{"lib", "util"},
		{"test_app", "app"},
	})
	cs := &ChangeSet{Changed: []string{"util"}, Tests: []string{"test_app"}}
	got := impactMap(Analyze(g, g, cs))["test_app"]
	want := Impact{Test: "test_app", Affected: true, Path: []string{"util", "lib", "app", "test_app"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestAnalyzeTieBreakSmallestIDSequence(t *testing.T) {
	// Two equally short paths from core to test_t:
	//   core -> mid_b -> test_t
	//   core -> mid_a -> test_t
	// The lexicographically smaller ID sequence must win.
	g := buildGraph(t, nil, [][2]string{
		{"mid_b", "core"},
		{"mid_a", "core"},
		{"test_t", "mid_b"},
		{"test_t", "mid_a"},
	})
	cs := &ChangeSet{Changed: []string{"core"}, Tests: []string{"test_t"}}
	got := impactMap(Analyze(g, g, cs))["test_t"]
	want := Impact{Test: "test_t", Affected: true, Path: []string{"core", "mid_a", "test_t"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestAnalyzeTieBreakAcrossSources(t *testing.T) {
	// src_b reaches test_t directly, src_a via hop; shortest wins first,
	// then the smaller ID sequence breaks the remaining tie.
	g := buildGraph(t, nil, [][2]string{
		{"test_t", "src_b"},
		{"test_t", "src_c"},
		{"hop", "src_a"},
		{"test_t", "hop"},
	})
	cs := &ChangeSet{Changed: []string{"src_a", "src_b", "src_c"}, Tests: []string{"test_t"}}
	got := impactMap(Analyze(g, g, cs))["test_t"]
	want := Impact{Test: "test_t", Affected: true, Path: []string{"src_b", "test_t"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestAnalyzeDeletedNodeKeepsOldInfluence(t *testing.T) {
	// Old graph: test_t -> ghost -> src. New graph deletes "ghost" and
	// reroutes test_t -> detour -> mid -> src (longer). The deleted node must
	// still carry impact, so the shortest path goes through "ghost".
	old := buildGraph(t, nil, [][2]string{
		{"test_t", "ghost"},
		{"ghost", "src"},
	})
	new := buildGraph(t, nil, [][2]string{
		{"test_t", "detour"},
		{"detour", "mid"},
		{"mid", "src"},
	})
	cs := &ChangeSet{Changed: []string{"src"}, Deleted: []string{"ghost"}, Tests: []string{"test_t"}}
	got := impactMap(Analyze(old, new, cs))["test_t"]
	want := Impact{Test: "test_t", Affected: true, Path: []string{"src", "ghost", "test_t"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestAnalyzeDeletedNodesInferredFromGraphs(t *testing.T) {
	old := buildGraph(t, []string{"gone", "stays"}, nil)
	new := buildGraph(t, []string{"stays"}, nil)
	got := DeletedNodes(old, new, &ChangeSet{})
	want := []string{"gone"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestAnalyzeCycleSafe(t *testing.T) {
	// a -> b -> c -> a is a dependency cycle; impact must still reach
	// test_t exactly once and terminate.
	g := buildGraph(t, nil, [][2]string{
		{"a", "b"},
		{"b", "c"},
		{"c", "a"},
		{"test_t", "c"},
	})
	cs := &ChangeSet{Changed: []string{"a"}, Tests: []string{"test_t"}}
	got := impactMap(Analyze(g, g, cs))["test_t"]
	// Impact flows along dependents: c depends on a, test_t depends on c.
	want := Impact{Test: "test_t", Affected: true, Path: []string{"a", "c", "test_t"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestAnalyzeUnreachableAndSelfChanged(t *testing.T) {
	g := buildGraph(t, []string{"isolated_test"}, [][2]string{
		{"test_hit", "src"},
	})
	cs := &ChangeSet{
		Changed: []string{"src", "test_hit"},
		Tests:   []string{"isolated_test", "test_hit"},
	}
	got := impactMap(Analyze(g, g, cs))
	if got["isolated_test"].Affected {
		t.Fatalf("isolated_test must be unaffected: %+v", got["isolated_test"])
	}
	want := Impact{Test: "test_hit", Affected: true, Path: []string{"test_hit"}}
	if !reflect.DeepEqual(got["test_hit"], want) {
		t.Fatalf("got %+v, want %+v", got["test_hit"], want)
	}
}

func TestAnalyzeResultsSortedByTestID(t *testing.T) {
	g := buildGraph(t, nil, [][2]string{{"t_b", "s"}, {"t_a", "s"}})
	cs := &ChangeSet{Changed: []string{"s"}, Tests: []string{"t_b", "t_a"}}
	got := Analyze(g, g, cs)
	if len(got) != 2 || got[0].Test != "t_a" || got[1].Test != "t_b" {
		t.Fatalf("results not sorted by test ID: %+v", got)
	}
}

func TestParseGraphAndChangeSet(t *testing.T) {
	g, err := ParseGraph([]byte(`{"nodes":["x"],"edges":[{"from":"a","to":"b"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if !g.Has("x") || !g.Has("a") || !reflect.DeepEqual(g.Dependents("b"), []string{"a"}) {
		t.Fatalf("unexpected graph: %v", g.Nodes())
	}
	cs, err := ParseChangeSet([]byte(`{"changed":["b"],"deleted":["c"],"tests":["t"]}`))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cs.Changed, []string{"b"}) || !reflect.DeepEqual(cs.Deleted, []string{"c"}) {
		t.Fatalf("unexpected change set: %+v", cs)
	}
	if _, err := ParseGraph([]byte(`{`)); err == nil {
		t.Fatal("expected error for malformed JSON")
	}
}

// --- Reference implementation: independent per-test search on the merged
// dual graph, used to verify Analyze. ---

// refItem is a priority-queue entry ordered by (distance, path sequence).
type refItem struct {
	node  string
	dist  int
	path  []string
	index int
}

type refQueue []*refItem

func (q refQueue) Len() int { return len(q) }
func (q refQueue) Less(i, j int) bool {
	if q[i].dist != q[j].dist {
		return q[i].dist < q[j].dist
	}
	return lessPath(q[i].path, q[j].path)
}
func (q refQueue) Swap(i, j int) { q[i], q[j] = q[j], q[i] }
func (q *refQueue) Push(x any)   { *q = append(*q, x.(*refItem)) }
func (q *refQueue) Pop() any {
	old := *q
	n := len(old)
	it := old[n-1]
	*q = old[:n-1]
	return it
}

// referenceImpact computes the impact for one test with a Dijkstra-style
// search over (distance, path sequence) on the merged graph. It shares no
// code with Analyze's layered BFS, so it serves as an independent oracle.
func referenceImpact(merged *Graph, changed []string, test string) Impact {
	imp := Impact{Test: test}
	pq := &refQueue{}
	heap.Init(pq)
	best := make(map[string][]string)
	for _, s := range dedupSorted(changed) {
		heap.Push(pq, &refItem{node: s, dist: 0, path: []string{s}})
	}
	for pq.Len() > 0 {
		it := heap.Pop(pq).(*refItem)
		if cur, ok := best[it.node]; ok && !lessPath(it.path, cur) {
			continue // stale queue entry
		}
		best[it.node] = it.path
		if it.node == test {
			imp.Affected = true
			imp.Path = it.path
			return imp
		}
		for _, dep := range merged.Dependents(it.node) {
			np := append(append([]string{}, it.path...), dep)
			if cur, ok := best[dep]; ok && !lessPath(np, cur) {
				continue
			}
			heap.Push(pq, &refItem{node: dep, dist: it.dist + 1, path: np})
		}
	}
	return imp
}

// checkAgainstReference verifies Analyze against the per-test reference on
// the merged dual graph (old ∪ new, deleted nodes included).
func checkAgainstReference(t *testing.T, old, new *Graph, cs *ChangeSet) {
	t.Helper()
	merged := Merge(old, new)
	for _, s := range cs.Changed {
		merged.AddNode(s)
	}
	got := impactMap(Analyze(old, new, cs))
	for _, test := range dedupSorted(cs.Tests) {
		want := referenceImpact(merged, cs.Changed, test)
		if !reflect.DeepEqual(got[test], want) {
			t.Fatalf("test %q: Analyze=%+v, reference=%+v", test, got[test], want)
		}
	}
}

func TestAnalyzeMatchesReferenceOnFixtures(t *testing.T) {
	old := buildGraph(t, nil, [][2]string{
		{"app", "lib"}, {"lib", "util"}, {"test_app", "app"},
		{"ghost", "util"}, {"test_legacy", "ghost"},
		{"x", "y"}, {"y", "z"}, {"z", "x"}, {"test_cyc", "z"},
	})
	new := buildGraph(t, nil, [][2]string{
		{"app", "lib"}, {"lib", "util"}, {"test_app", "app"},
		{"x", "y"}, {"y", "z"}, {"z", "x"}, {"test_cyc", "z"},
		{"test_legacy", "util"},
	})
	cs := &ChangeSet{
		Changed: []string{"util", "y"},
		Deleted: []string{"ghost"},
		Tests:   []string{"test_app", "test_legacy", "test_cyc", "util"},
	}
	checkAgainstReference(t, old, new, cs)
}

func TestAnalyzeMatchesReferenceRandomized(t *testing.T) {
	rng := rand.New(rand.NewSource(20261006))
	for trial := 0; trial < 300; trial++ {
		n := 2 + rng.Intn(12)
		ids := make([]string, n)
		for i := range ids {
			ids[i] = fmt.Sprintf("n%02d", i)
		}
		randGraph := func(maxEdges int) *Graph {
			g := NewGraph()
			for _, id := range ids {
				if rng.Intn(4) != 0 { // some nodes only exist in one graph
					g.AddNode(id)
				}
			}
			for e := 0; e < maxEdges; e++ {
				g.AddEdge(ids[rng.Intn(n)], ids[rng.Intn(n)]) // cycles allowed
			}
			return g
		}
		old := randGraph(rng.Intn(2 * n))
		new := randGraph(rng.Intn(2 * n))

		pick := func(k int) []string {
			out := make([]string, 0, k)
			for i := 0; i < k; i++ {
				out = append(out, ids[rng.Intn(n)])
			}
			return out
		}
		cs := &ChangeSet{
			Changed: pick(1 + rng.Intn(3)),
			Deleted: pick(rng.Intn(3)),
			Tests:   pick(1 + rng.Intn(4)),
		}
		checkAgainstReference(t, old, new, cs)
	}
}
