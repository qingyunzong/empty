package verify_test

import (
	"fmt"
	"math/rand"
	"testing"

	"graphlib/graph"
	"graphlib/verify"
)

// TestRandomOperationSequences drives random add/remove/undo sequences
// and runs the full independent verification after every mutation.
func TestRandomOperationSequences(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	const (
		rounds    = 60
		opsPerRun = 40
		numIDs    = 12 // ≤ bruteForceLimit so enumeration always applies
	)
	ids := make([]string, numIDs)
	for i := range ids {
		ids[i] = fmt.Sprintf("v%02d", i)
	}
	for round := 0; round < rounds; round++ {
		g := graph.New()
		// A few isolated vertices from the start.
		for _, id := range ids[:rng.Intn(3)] {
			g.AddVertex(id)
		}
		for op := 0; op < opsPerRun; op++ {
			u := ids[rng.Intn(numIDs)]
			v := ids[rng.Intn(numIDs)]
			switch rng.Intn(5) {
			case 0, 1, 2:
				if _, err := g.AddEdge(u, v); err != nil && err != graph.ErrSelfLoop && err != graph.ErrNotBipartite {
					t.Fatalf("round %d op %d: unexpected AddEdge error %v", round, op, err)
				}
			case 3:
				g.RemoveEdge(u, v)
			case 4:
				g.Undo()
			}
			a := g.Analyze()
			if err := verify.Analysis(g, a); err != nil {
				t.Fatalf("round %d op %d (version %d, edges %v): %v",
					round, op, g.Version(), g.Edges(), err)
			}
		}
	}
}

// TestUndoConsistency records every version's analysis, then undoes
// everything and checks that each revisited state matches its
// recorded snapshot exactly.
func TestUndoConsistency(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	g := graph.New()
	ids := []string{"a", "b", "c", "d", "e", "f"}
	type snapshot struct {
		matching []graph.Edge
		cover    []string
		edges    []graph.Edge
	}
	var snaps []snapshot
	record := func() {
		a := g.Analyze()
		snaps = append(snaps, snapshot{a.Matching, a.Cover, g.Edges()})
	}
	record()
	mutations := 0
	for mutations < 25 {
		u := ids[rng.Intn(len(ids))]
		v := ids[rng.Intn(len(ids))]
		before := g.Version()
		if rng.Intn(3) == 0 {
			g.RemoveEdge(u, v)
		} else {
			g.AddEdge(u, v) // duplicate/self-loop/non-bipartite: no-op
		}
		if g.Version() == before {
			continue // idempotent no-op: nothing logged, nothing to record
		}
		mutations++
		record()
	}
	for i := len(snaps) - 2; i >= 0; i-- {
		if _, ok := g.Undo(); !ok {
			t.Fatalf("undo %d failed", i)
		}
		a := g.Analyze()
		want := snaps[i]
		if !equalEdges(a.Matching, want.matching) || !equalStrings(a.Cover, want.cover) ||
			!equalEdges(g.Edges(), want.edges) {
			t.Fatalf("state %d mismatch after undo:\n got  %+v\n want %+v", i, a, want)
		}
		if err := verify.Analysis(g, a); err != nil {
			t.Fatalf("state %d failed verification: %v", i, err)
		}
	}
}

func equalEdges(a, b []graph.Edge) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestVerifierRejectsBadInput confirms the verifier actually catches
// invalid matchings, invalid covers and size mismatches.
func TestVerifierRejectsBadInput(t *testing.T) {
	g := graph.New()
	g.AddEdge("a", "x")
	g.AddEdge("b", "x")
	g.AddEdge("b", "y")

	if err := verify.CheckMatching(g, []graph.Edge{{U: "a", V: "x"}, {U: "b", V: "x"}}); err == nil {
		t.Fatal("accepted matching that shares vertex x")
	}
	if err := verify.CheckMatching(g, []graph.Edge{{U: "a", V: "y"}}); err == nil {
		t.Fatal("accepted matching with a non-existent edge")
	}
	if err := verify.CheckCover(g, []string{"x", "y"}); err != nil {
		t.Fatalf("rejected valid cover {x,y}: %v", err)
	}
	if err := verify.CheckCover(g, []string{"b"}); err == nil {
		t.Fatal("accepted non-cover {b} (edge {a,x} uncovered)")
	}
	if err := verify.CheckCover(g, []string{"nobody"}); err == nil {
		t.Fatal("accepted cover with unknown vertex")
	}
	if err := verify.CheckEqualSize([]graph.Edge{{U: "a", V: "x"}}, nil); err == nil {
		t.Fatal("accepted size mismatch")
	}
	a := graph.Analysis{Version: g.Version(), Matching: []graph.Edge{{U: "a", V: "x"}}, Cover: []string{"x", "y"}}
	if err := verify.Analysis(g, a); err == nil {
		t.Fatal("accepted sub-maximum matching with mismatched cover size")
	}
}

// TestBruteForceMinCover cross-checks the enumerator on hand-built
// graphs with known minima.
func TestBruteForceMinCover(t *testing.T) {
	cases := []struct {
		name  string
		edges []graph.Edge
		want  int
	}{
		{"empty", nil, 0},
		{"single edge", []graph.Edge{{U: "a", V: "b"}}, 1},
		{"path P4", []graph.Edge{{U: "a", V: "b"}, {U: "b", V: "c"}, {U: "c", V: "d"}}, 2},
		{"star", []graph.Edge{{U: "c", V: "x"}, {U: "c", V: "y"}, {U: "c", V: "z"}}, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := graph.New()
			for _, e := range tc.edges {
				g.AddEdge(e.U, e.V)
			}
			got, ok := verify.MinCoverSize(g)
			if !ok || got != tc.want {
				t.Fatalf("MinCoverSize = (%d, %v), want (%d, true)", got, ok, tc.want)
			}
		})
	}
	// Beyond the enumeration limit the verifier must report !ok.
	big := graph.New()
	for i := 0; i < 25; i++ {
		big.AddVertex(fmt.Sprintf("iso%d", i))
	}
	if _, ok := verify.MinCoverSize(big); ok {
		t.Fatal("expected !ok for graph beyond brute-force limit")
	}
}
