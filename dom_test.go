package dom

import (
	"math/rand"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func mustDominators(t *testing.T, v *Version, n string, want ...string) {
	t.Helper()
	got, ok := v.Dominators(n)
	if !ok {
		t.Fatalf("Dominators(%q): expected ok, got unreachable/unknown", n)
	}
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Dominators(%q) = %v, want %v", n, got, want)
	}
}

func mustNCD(t *testing.T, v *Version, a, b, want string) {
	t.Helper()
	got, ok := v.NCD(a, b)
	if !ok || got != want {
		t.Errorf("NCD(%q, %q) = (%q, %v), want (%q, true)", a, b, got, ok, want)
	}
}

func mustDF(t *testing.T, v *Version, n string, want ...string) {
	t.Helper()
	got := v.DominanceFrontier(n)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("DominanceFrontier(%q) = %v, want %v", n, got, want)
	}
}

// Diamond: r->a, r->b, a->c, b->c, c->d.
func diamond() *Graph {
	g := New("r")
	g.AddEdge("r", "a")
	g.AddEdge("r", "b")
	g.AddEdge("a", "c")
	g.AddEdge("b", "c")
	g.AddEdge("c", "d")
	return g
}

func TestDiamondDominatorSets(t *testing.T) {
	v := diamond().Latest()
	mustDominators(t, v, "r", "r")
	mustDominators(t, v, "a", "a", "r")
	mustDominators(t, v, "b", "b", "r")
	mustDominators(t, v, "c", "c", "r")
	mustDominators(t, v, "d", "c", "d", "r")
	if id, ok := v.IDom("c"); !ok || id != "r" {
		t.Errorf("IDom(c) = (%q, %v), want (r, true)", id, ok)
	}
	if id, ok := v.IDom("d"); !ok || id != "c" {
		t.Errorf("IDom(d) = (%q, %v), want (c, true)", id, ok)
	}
	if _, ok := v.IDom("r"); ok {
		t.Error("IDom(r) should report false for the entry")
	}
	if err := v.Verify(); err != nil {
		t.Error(err)
	}
}

func TestDiamondNCD(t *testing.T) {
	v := diamond().Latest()
	mustNCD(t, v, "a", "b", "r")
	mustNCD(t, v, "a", "c", "r")
	mustNCD(t, v, "c", "d", "c")
	mustNCD(t, v, "a", "a", "a")
	mustNCD(t, v, "b", "d", "r")
}

func TestDiamondDominanceFrontier(t *testing.T) {
	v := diamond().Latest()
	mustDF(t, v, "r")
	mustDF(t, v, "a", "c")
	mustDF(t, v, "b", "c")
	mustDF(t, v, "c")
	mustDF(t, v, "d")
}

// Loop: r->a, a->b, b->c, c->b (back edge), b->d.
func TestLoop(t *testing.T) {
	g := New("r")
	for _, e := range [][2]string{{"r", "a"}, {"a", "b"}, {"b", "c"}, {"c", "b"}, {"b", "d"}} {
		g.AddEdge(e[0], e[1])
	}
	v := g.Latest()
	mustDominators(t, v, "b", "a", "b", "r")
	mustDominators(t, v, "c", "a", "b", "c", "r")
	mustDominators(t, v, "d", "a", "b", "d", "r")
	mustDF(t, v, "c", "b")
	// b is a loop header: it dominates c (a predecessor of b) without
	// strictly dominating itself, so b is in its own frontier.
	mustDF(t, v, "b", "b")
	mustNCD(t, v, "c", "d", "b")
	if err := v.Verify(); err != nil {
		t.Error(err)
	}
}

// Edge insertion must produce a new version while the old one keeps
// answering with its original results.
func TestAddEdgeKeepsOldVersionReadable(t *testing.T) {
	g := New("r")
	g.AddEdge("r", "a")
	g.AddEdge("a", "b")
	g.AddEdge("b", "c")
	v1 := g.Latest()
	evidence1 := v1.Evidence()

	v2 := g.AddEdge("r", "c") // shortcut: a and b no longer dominate c

	if v2.Seq() <= v1.Seq() {
		t.Fatalf("expected new version, got seq %d after %d", v2.Seq(), v1.Seq())
	}
	// Old version: chain dominators.
	mustDominators(t, v1, "c", "a", "b", "c", "r")
	mustNCD(t, v1, "b", "c", "b")
	if got := v1.Evidence(); got != evidence1 {
		t.Errorf("old version evidence changed after mutation:\n%s", got)
	}
	// New version: shortcut dominators.
	mustDominators(t, v2, "c", "c", "r")
	mustNCD(t, v2, "b", "c", "r")
	if id, _ := v2.IDom("c"); id != "r" {
		t.Errorf("IDom(c) = %q, want r", id)
	}
	if err := v2.Verify(); err != nil {
		t.Error(err)
	}
}

// Edge deletion can make nodes unreachable; they must be listed
// separately and excluded from dominator queries.
func TestRemoveEdgeUnreachable(t *testing.T) {
	g := New("r")
	g.AddEdge("r", "a")
	g.AddEdge("a", "b")
	g.AddEdge("r", "b") // redundant path
	v1 := g.Latest()
	if !v1.Reachable("b") {
		t.Fatal("b should be reachable before deletions")
	}

	v2 := g.RemoveEdge("a", "b")
	if !v2.Reachable("b") {
		t.Fatal("b should still be reachable via r->b")
	}
	mustDominators(t, v2, "b", "b", "r")

	v3 := g.RemoveEdge("r", "b")
	if got := v3.Unreachable(); !reflect.DeepEqual(got, []string{"b"}) {
		t.Fatalf("Unreachable() = %v, want [b]", got)
	}
	if _, ok := v3.Dominators("b"); ok {
		t.Error("Dominators(b) must report false for an unreachable node")
	}
	if _, ok := v3.NCD("a", "b"); ok {
		t.Error("NCD(a, b) must report false when b is unreachable")
	}
	// Unreachable nodes must not appear in any reachable dominator set.
	for _, n := range []string{"r", "a"} {
		ds, _ := v3.Dominators(n)
		for _, d := range ds {
			if d == "b" {
				t.Errorf("unreachable node b leaked into Dominators(%q)", n)
			}
		}
	}
	// The pre-deletion version still sees b as reachable.
	mustDominators(t, v1, "b", "b", "r")
	if err := v3.Verify(); err != nil {
		t.Error(err)
	}
}

// AddNode creates an isolated (unreachable) node; connecting it later
// moves it into the dominator tree.
func TestIsolatedNodeThenConnect(t *testing.T) {
	g := New("r")
	v1 := g.AddNode("x")
	if got := v1.Unreachable(); !reflect.DeepEqual(got, []string{"x"}) {
		t.Fatalf("Unreachable() = %v, want [x]", got)
	}
	v2 := g.AddEdge("r", "x")
	if len(v2.Unreachable()) != 0 {
		t.Fatalf("Unreachable() = %v, want empty", v2.Unreachable())
	}
	mustDominators(t, v2, "x", "r", "x")
}

func TestEvidenceFormat(t *testing.T) {
	v := diamond().Latest()
	ev := v.Evidence()
	for _, want := range []string{
		"version 5 (entry=r)",
		"  c: {c, r}",
		"  d: {c, d, r}",
		"unreachable: (none)",
	} {
		if !strings.Contains(ev, want) {
			t.Errorf("evidence missing %q:\n%s", want, ev)
		}
	}
}

// Random small graphs: every committed version is cross-checked by the
// independent node-deletion method, and NCD / dominance frontier are
// compared against brute-force definitions derived from dominator sets.
func TestRandomSmallGraphs(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 200; trial++ {
		n := 2 + rng.Intn(7) // 2..8 nodes
		names := make([]string, n)
		for i := range names {
			names[i] = string(rune('a' + i))
		}
		g := New(names[0])
		var versions []*Version
		ops := 1 + rng.Intn(2*n)
		for op := 0; op < ops; op++ {
			from := names[rng.Intn(n)]
			to := names[rng.Intn(n)]
			if rng.Intn(4) == 0 {
				versions = append(versions, g.RemoveEdge(from, to))
			} else {
				versions = append(versions, g.AddEdge(from, to))
			}
		}
		versions = append(versions, g.Latest())
		for _, v := range versions {
			if err := v.Verify(); err != nil {
				t.Fatalf("trial %d: %v", trial, err)
			}
			checkNCDBruteForce(t, v)
			checkDFBruteForce(t, v)
		}
	}
}

// NCD must be the deepest common dominator of a and b.
func checkNCDBruteForce(t *testing.T, v *Version) {
	t.Helper()
	for _, a := range v.Nodes() {
		for _, b := range v.Nodes() {
			got, ok := v.NCD(a, b)
			if !v.Reachable(a) || !v.Reachable(b) {
				if ok {
					t.Errorf("NCD(%q,%q) should fail for unreachable input", a, b)
				}
				continue
			}
			da, _ := v.Dominators(a)
			db, _ := v.Dominators(b)
			common := map[string]bool{}
			for _, d := range da {
				common[d] = true
			}
			want := ""
			wantDepth := -1
			for _, d := range db {
				if !common[d] {
					continue
				}
				depth := len(mustDomSet(t, v, d)) - 1 // depth == |dom(d)| - 1
				if depth > wantDepth {
					want, wantDepth = d, depth
				}
			}
			if !ok || got != want {
				t.Errorf("NCD(%q,%q) = (%q,%v), brute force wants %q", a, b, got, ok, want)
			}
		}
	}
}

func mustDomSet(t *testing.T, v *Version, n string) []string {
	t.Helper()
	ds, ok := v.Dominators(n)
	if !ok {
		t.Fatalf("no dominator set for reachable node %q", n)
	}
	return ds
}

// DF(n) = { y : n dominates some reachable predecessor of y, and n does
// not strictly dominate y } (Cytron et al.), computed from dominator sets.
func checkDFBruteForce(t *testing.T, v *Version) {
	t.Helper()
	for _, n := range v.Nodes() {
		if !v.Reachable(n) {
			continue
		}
		want := map[string]bool{}
		for _, y := range v.Nodes() {
			if !v.Reachable(y) {
				continue
			}
			domY := mustDomSet(t, v, y)
			strictlyDominates := contains(domY, n) && n != y
			if strictlyDominates {
				continue
			}
			for _, p := range v.pred[y] {
				if v.Reachable(p) && contains(mustDomSet(t, v, p), n) {
					want[y] = true
					break
				}
			}
		}
		got := map[string]bool{}
		for _, y := range v.DominanceFrontier(n) {
			got[y] = true
		}
		if !sameSet(got, want) {
			t.Errorf("DF(%q) = {%s}, brute force wants {%s}",
				n, joinSorted(got), joinSorted(want))
		}
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
