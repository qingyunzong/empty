package impact

import (
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestAnalyzeShortestPath(t *testing.T) {
	g := NewGraph(map[string][]string{
		"test_a": {"svc"},
		"svc":    {"repo"},
		"repo":   {"db"},
		"other":  {"util"},
	})
	cs := &ChangeSet{Changed: []string{"db"}}
	got := Analyze(g, nil, cs, []string{"test_a", "other"})
	want := []Result{
		{Test: "test_a", Affected: true, Path: []string{"test_a", "svc", "repo", "db"}},
		{Test: "other", Affected: false, Path: nil},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Analyze() = %+v, want %+v", got, want)
	}
}

func TestAnalyzeTieBreakSmallestIDSequence(t *testing.T) {
	// Two shortest paths of equal length from test_t to the changed
	// file "hit": via "mid_b" and via "mid_a". The lexicographically
	// smaller node-ID sequence must win.
	g := NewGraph(map[string][]string{
		"test_t": {"mid_b", "mid_a"},
		"mid_a":  {"hit"},
		"mid_b":  {"hit"},
	})
	cs := &ChangeSet{Changed: []string{"hit"}}
	got := Analyze(g, nil, cs, []string{"test_t"})
	wantPath := []string{"test_t", "mid_a", "hit"}
	if !got[0].Affected || !reflect.DeepEqual(got[0].Path, wantPath) {
		t.Fatalf("path = %v, want %v", got[0].Path, wantPath)
	}
}

func TestAnalyzeTieBreakPrefersShorterOverLexicographic(t *testing.T) {
	// A longer path with a lexicographically smaller sequence must not
	// beat a genuinely shorter path.
	g := NewGraph(map[string][]string{
		"test_t": {"z", "a"},
		"z":      {"hit"},
		"a":      {"b"},
		"b":      {"hit"},
	})
	cs := &ChangeSet{Changed: []string{"hit"}}
	got := Analyze(g, nil, cs, []string{"test_t"})
	wantPath := []string{"test_t", "z", "hit"}
	if !reflect.DeepEqual(got[0].Path, wantPath) {
		t.Fatalf("path = %v, want %v", got[0].Path, wantPath)
	}
}

func TestAnalyzeCycleSafe(t *testing.T) {
	g := NewGraph(map[string][]string{
		"test_c": {"a"},
		"a":      {"b", "test_c"}, // cycle back to the test
		"b":      {"a", "hot"},    // cycle a<->b plus exit
		"hot":    {"a"},           // cycle through the changed node
	})
	cs := &ChangeSet{Changed: []string{"hot"}}
	got := Analyze(g, nil, cs, []string{"test_c"})
	wantPath := []string{"test_c", "a", "b", "hot"}
	if !got[0].Affected || !reflect.DeepEqual(got[0].Path, wantPath) {
		t.Fatalf("path = %v, want %v", got[0].Path, wantPath)
	}
}

func TestAnalyzeSelfLoopAndPureCycle(t *testing.T) {
	g := NewGraph(map[string][]string{
		"test_s": {"test_s", "x"}, // self loop
		"x":      {"y"},
		"y":      {"x"}, // x<->y cycle with no exit
	})
	cs := &ChangeSet{Changed: []string{"elsewhere"}}
	got := Analyze(g, nil, cs, []string{"test_s"})
	if got[0].Affected {
		t.Fatalf("expected unaffected test, got %+v", got[0])
	}
}

func TestAnalyzeDeletedNodeKeepsOldInfluence(t *testing.T) {
	oldGraph := NewGraph(map[string][]string{
		"test_d": {"legacy"},
		"legacy": {"core"},
		"core":   {"db"},
	})
	// In the new graph "legacy" is deleted: test_d depends on core
	// directly and legacy/core edges are gone.
	newGraph := NewGraph(map[string][]string{
		"test_d": {"core"},
		"core":   {"db"},
	})
	cs := &ChangeSet{Changed: []string{"db"}, Deleted: []string{"legacy"}}
	got := Analyze(oldGraph, newGraph, cs, []string{"test_d"})

	// The deleted node "legacy" is itself a change target reachable via
	// the retained old-graph edge test_d -> legacy, giving a shorter
	// path than test_d -> core -> db.
	wantPath := []string{"test_d", "legacy"}
	if !got[0].Affected || !reflect.DeepEqual(got[0].Path, wantPath) {
		t.Fatalf("path = %v, want %v", got[0].Path, wantPath)
	}
}

func TestAnalyzeDeletedNodeOutgoingEdgesMerged(t *testing.T) {
	// The deleted node is not a target itself here; its old outgoing
	// edges must still propagate influence after the merge.
	oldGraph := NewGraph(map[string][]string{
		"test_e": {"gone"},
		"gone":   {"hot"},
	})
	newGraph := NewGraph(map[string][]string{
		"test_e": {"cold"},
	})
	cs := &ChangeSet{Changed: []string{"hot"}, Deleted: []string{"gone"}}
	got := Analyze(oldGraph, newGraph, cs, []string{"test_e"})
	// "gone" is deleted, hence a target: shortest path ends there.
	wantPath := []string{"test_e", "gone"}
	if !reflect.DeepEqual(got[0].Path, wantPath) {
		t.Fatalf("path = %v, want %v", got[0].Path, wantPath)
	}

	// Without the deletion, influence flows through the merged
	// old-graph edge gone -> hot.
	cs2 := &ChangeSet{Changed: []string{"hot"}}
	got2 := Analyze(oldGraph, newGraph, cs2, []string{"test_e"})
	wantPath2 := []string{"test_e", "gone", "hot"}
	if !reflect.DeepEqual(got2[0].Path, wantPath2) {
		t.Fatalf("path = %v, want %v", got2[0].Path, wantPath2)
	}
}

func TestAnalyzeTestItselfChanged(t *testing.T) {
	g := NewGraph(map[string][]string{"test_f": {"a"}})
	cs := &ChangeSet{Changed: []string{"test_f", "a"}}
	got := Analyze(g, nil, cs, []string{"test_f"})
	wantPath := []string{"test_f"}
	if !got[0].Affected || !reflect.DeepEqual(got[0].Path, wantPath) {
		t.Fatalf("path = %v, want %v", got[0].Path, wantPath)
	}
}

func TestLoaders(t *testing.T) {
	dir := t.TempDir()

	graphPath := filepath.Join(dir, "graph.json")
	if err := os.WriteFile(graphPath, []byte(
		`{"edges": {"t": ["a", "a", "b"], "a": ["c"]}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	g, err := LoadGraphFile(graphPath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(g.Edges["t"], []string{"a", "b"}) {
		t.Fatalf("edges not deduped/sorted: %v", g.Edges["t"])
	}

	csPath := filepath.Join(dir, "changes.json")
	if err := os.WriteFile(csPath, []byte(
		`{"changed": ["c"], "deleted": ["old"]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	cs, err := LoadChangeSetFile(csPath)
	if err != nil {
		t.Fatal(err)
	}
	if !cs.Targets()["c"] || !cs.Targets()["old"] {
		t.Fatalf("targets missing: %+v", cs)
	}

	testsPath := filepath.Join(dir, "tests.json")
	if err := os.WriteFile(testsPath, []byte(`["t", "u"]`), 0o644); err != nil {
		t.Fatal(err)
	}
	tests, err := LoadTestsFile(testsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(tests, []string{"t", "u"}) {
		t.Fatalf("tests = %v", tests)
	}

	if _, err := LoadGraph(strings.NewReader(`{bad json`)); err == nil {
		t.Fatal("expected decode error")
	}
}

// TestShortestPathAgainstReference cross-verifies the BFS
// implementation against the exhaustive reference on random graphs with
// cycles, on the old graph, the new graph, and their merge.
func TestShortestPathAgainstReference(t *testing.T) {
	rng := rand.New(rand.NewSource(20261008))
	for trial := 0; trial < 300; trial++ {
		oldGraph, newGraph, cs, tests := randomScenario(rng)
		merged := Merge(oldGraph, newGraph)
		targets := cs.Targets()
		graphs := map[string]*Graph{
			"old":    oldGraph,
			"new":    newGraph,
			"merged": merged,
		}
		for name, g := range graphs {
			for _, test := range tests {
				got := shortestPath(g, test, targets)
				want := referenceShortestPath(g, test, targets)
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("trial %d graph %s test %q: BFS=%v reference=%v",
						trial, name, test, got, want)
				}
			}
		}
	}
}

// TestAnalyzeMatchesReferenceOnMergedGraph verifies the public Analyze
// entry point against the reference on the merged graph.
func TestAnalyzeMatchesReferenceOnMergedGraph(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for trial := 0; trial < 200; trial++ {
		oldGraph, newGraph, cs, tests := randomScenario(rng)
		merged := Merge(oldGraph, newGraph)
		targets := cs.Targets()
		got := Analyze(oldGraph, newGraph, cs, tests)
		for i, test := range tests {
			want := referenceShortestPath(merged, test, targets)
			if got[i].Test != test || !reflect.DeepEqual(got[i].Path, want) {
				t.Fatalf("trial %d test %q: Analyze=%+v reference path=%v",
					trial, test, got[i], want)
			}
			if got[i].Affected != (want != nil) {
				t.Fatalf("trial %d test %q: Affected=%v, want %v",
					trial, test, got[i].Affected, want != nil)
			}
		}
	}
}

// randomScenario builds a small random old/new graph pair (with cycles
// and deleted nodes), a change set, and a test list.
func randomScenario(rng *rand.Rand) (oldGraph, newGraph *Graph, cs *ChangeSet, tests []string) {
	n := 3 + rng.Intn(6) // 3..8 nodes
	ids := make([]string, n)
	for i := range ids {
		ids[i] = fmt.Sprintf("n%d", i)
	}
	randomGraph := func() *Graph {
		edges := map[string][]string{}
		for _, id := range ids {
			var deps []string
			for _, dep := range ids {
				if rng.Intn(4) == 0 { // ~25% edge probability, allows cycles
					deps = append(deps, dep)
				}
			}
			if len(deps) > 0 {
				edges[id] = deps
			}
		}
		return NewGraph(edges)
	}
	oldGraph, newGraph = randomGraph(), randomGraph()

	cs = &ChangeSet{}
	for _, id := range ids {
		switch rng.Intn(6) {
		case 0:
			cs.Changed = append(cs.Changed, id)
		case 1:
			cs.Deleted = append(cs.Deleted, id)
		}
	}
	// Use every node as a test plus one unknown ID.
	tests = append([]string{}, ids...)
	tests = append(tests, "ghost")
	return oldGraph, newGraph, cs, tests
}
