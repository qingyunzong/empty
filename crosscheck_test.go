package cfglib

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

// sameStringSet reports whether two sorted string slices are equal,
// treating nil and empty as equal.
func sameStringSet(a, b []string) bool {
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

// checkAgainstNaive compares every query of the dominator-tree analysis
// against the independent node-deletion reachability implementation.
func checkAgainstNaive(t *testing.T, g *Graph) {
	t.Helper()
	a := g.Analyze()
	naiveDoms := NaiveDominators(g)

	// Reachability and unreachable set.
	for _, n := range g.Nodes() {
		_, naiveReach := naiveDoms[n]
		if a.Reachable(n) != naiveReach {
			t.Fatalf("reachability mismatch for %s: tree=%v naive=%v", n, a.Reachable(n), naiveReach)
		}
	}
	var naiveUnreach []string
	for _, n := range g.Nodes() {
		if _, ok := naiveDoms[n]; !ok {
			naiveUnreach = append(naiveUnreach, n)
		}
	}
	if got := a.Unreachable(); !sameStringSet(got, naiveUnreach) {
		t.Fatalf("Unreachable() = %v; naive %v", got, naiveUnreach)
	}

	// Full dominator sets.
	for n, want := range naiveDoms {
		gotSet := make(map[string]bool)
		for _, d := range a.Dominators(n) {
			gotSet[d] = true
		}
		if !reflect.DeepEqual(gotSet, want) {
			t.Fatalf("Dominators(%s) = %v; naive %v", n, gotSet, want)
		}
	}

	// Immediate dominator: the strict dominator with the largest dom set.
	for n, ds := range naiveDoms {
		if n == g.Entry() {
			continue
		}
		best, bestSize := "", -1
		for d := range ds {
			if d != n && len(naiveDoms[d]) > bestSize {
				best, bestSize = d, len(naiveDoms[d])
			}
		}
		if got, _ := a.ImmediateDominator(n); got != best {
			t.Fatalf("idom(%s) = %s; naive %s", n, got, best)
		}
	}

	// Dominance frontiers.
	naiveDF := NaiveDominanceFrontier(g)
	for n := range naiveDoms {
		got := make(map[string]bool)
		for _, d := range a.DominanceFrontier(n) {
			got[d] = true
		}
		if !reflect.DeepEqual(got, naiveDF[n]) {
			t.Fatalf("DF(%s) = %v; naive %v", n, got, naiveDF[n])
		}
	}

	// Nearest common dominator for all pairs.
	nodes := g.Nodes()
	for _, x := range nodes {
		for _, y := range nodes {
			got, gotOK := a.NearestCommonDominator(x, y)
			want, wantOK := NaiveNearestCommonDominator(g, x, y)
			if gotOK != wantOK || (gotOK && got != want) {
				t.Fatalf("NCD(%s,%s) = %q,%v; naive %q,%v", x, y, got, gotOK, want, wantOK)
			}
		}
	}
}

func TestCrossCheckDeterministicGraphs(t *testing.T) {
	graphs := map[string]*Graph{
		"diamond":     buildDiamond(),
		"single":      New("A"),
		"chain":       New("A").AddEdge("A", "B").AddEdge("B", "C").AddEdge("C", "D"),
		"selfloop":    New("A").AddEdge("A", "A").AddEdge("A", "B").AddEdge("B", "B"),
		"entrycycle":  New("A").AddEdge("A", "B").AddEdge("B", "A").AddEdge("B", "C").AddEdge("C", "A"),
		"unreachable": buildDiamond().AddNode("Z").AddEdge("Z", "Y").AddEdge("Y", "Z").AddEdge("Y", "A"),
		"loop": New("E").AddEdge("E", "H").AddEdge("H", "B").
			AddEdge("B", "H").AddEdge("B", "X").AddEdge("H", "X"),
	}
	for name, g := range graphs {
		t.Run(name, func(t *testing.T) { checkAgainstNaive(t, g) })
	}
}

// TestCrossCheckRandomMutations builds random small graphs and applies
// random edge insertions and deletions, cross-checking the maintained
// dominator tree against the naive method after every single mutation.
func TestCrossCheckRandomMutations(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 150; trial++ {
		n := 2 + rng.Intn(7)
		names := make([]string, n)
		for i := range names {
			names[i] = fmt.Sprintf("n%d", i)
		}
		g := New(names[0])
		for _, name := range names[1:] {
			g = g.AddNode(name)
		}
		for _, u := range names {
			for _, v := range names {
				if rng.Intn(100) < 30 {
					g = g.AddEdge(u, v)
				}
			}
		}
		checkAgainstNaive(t, g)

		for step := 0; step < 12; step++ {
			u := names[rng.Intn(n)]
			v := names[rng.Intn(n)]
			if rng.Intn(2) == 0 {
				g = g.AddEdge(u, v)
			} else {
				g = g.RemoveEdge(u, v)
			}
			if !t.Run(fmt.Sprintf("trial%d/step%d", trial, step), func(t *testing.T) {
				checkAgainstNaive(t, g)
			}) {
				t.Fatalf("graph at failure:\n%s", g.Analyze().String())
			}
		}
	}
}
