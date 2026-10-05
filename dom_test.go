package cfglib

import (
	"reflect"
	"strings"
	"testing"
)

func buildDiamond() *Graph {
	// A -> B, A -> C, B -> D, C -> D, D -> E
	return New("A").
		AddEdge("A", "B").AddEdge("A", "C").
		AddEdge("B", "D").AddEdge("C", "D").
		AddEdge("D", "E")
}

func TestDominatorTreeDiamond(t *testing.T) {
	a := buildDiamond().Analyze()
	wantIDom := map[string]string{"A": "A", "B": "A", "C": "A", "D": "A", "E": "D"}
	for n, want := range wantIDom {
		got, ok := a.ImmediateDominator(n)
		if !ok || got != want {
			t.Errorf("idom(%s) = %q, %v; want %q", n, got, ok, want)
		}
	}
	wantDoms := map[string][]string{
		"A": {"A"},
		"B": {"A", "B"},
		"C": {"A", "C"},
		"D": {"A", "D"},
		"E": {"A", "D", "E"},
	}
	for n, want := range wantDoms {
		if got := a.Dominators(n); !reflect.DeepEqual(got, want) {
			t.Errorf("Dominators(%s) = %v; want %v", n, got, want)
		}
	}
}

func TestDominanceFrontierDiamond(t *testing.T) {
	a := buildDiamond().Analyze()
	if got := a.DominanceFrontier("B"); !reflect.DeepEqual(got, []string{"D"}) {
		t.Errorf("DF(B) = %v; want [D]", got)
	}
	if got := a.DominanceFrontier("C"); !reflect.DeepEqual(got, []string{"D"}) {
		t.Errorf("DF(C) = %v; want [D]", got)
	}
	if got := a.DominanceFrontier("D"); len(got) != 0 {
		t.Errorf("DF(D) = %v; want empty", got)
	}
}

func TestDominanceFrontierLoop(t *testing.T) {
	// E -> H, H -> B, B -> H (back edge), B -> X, H -> X
	g := New("E").
		AddEdge("E", "H").AddEdge("H", "B").
		AddEdge("B", "H").AddEdge("B", "X").AddEdge("H", "X")
	a := g.Analyze()
	wantDF := map[string][]string{
		"B": {"H", "X"},
		"H": {"H"},
	}
	for n, want := range wantDF {
		if got := a.DominanceFrontier(n); !reflect.DeepEqual(got, want) {
			t.Errorf("DF(%s) = %v; want %v", n, got, want)
		}
	}
	if got := a.DominanceFrontier("E"); len(got) != 0 {
		t.Errorf("DF(E) = %v; want empty", got)
	}
}

func TestNearestCommonDominator(t *testing.T) {
	a := buildDiamond().Analyze()
	cases := []struct{ x, y, want string }{
		{"B", "C", "A"},
		{"B", "E", "A"},
		{"D", "E", "D"},
		{"A", "E", "A"},
		{"B", "B", "B"},
	}
	for _, c := range cases {
		got, ok := a.NearestCommonDominator(c.x, c.y)
		if !ok || got != c.want {
			t.Errorf("NCD(%s,%s) = %q,%v; want %q", c.x, c.y, got, ok, c.want)
		}
	}
}

func TestUnreachableListedSeparately(t *testing.T) {
	g := buildDiamond().AddNode("Z").AddEdge("Z", "A")
	a := g.Analyze()
	if got := a.Unreachable(); !reflect.DeepEqual(got, []string{"Z"}) {
		t.Fatalf("Unreachable() = %v; want [Z]", got)
	}
	if a.Reachable("Z") {
		t.Error("Z must not be reachable")
	}
	if got := a.Dominators("Z"); got != nil {
		t.Errorf("Dominators(Z) = %v; want nil", got)
	}
	if _, ok := a.ImmediateDominator("Z"); ok {
		t.Error("idom(Z) must be absent")
	}
	if _, ok := a.NearestCommonDominator("A", "Z"); ok {
		t.Error("NCD with unreachable node must fail")
	}
	// Reachable part is unaffected by the unreachable in-edge.
	if got := a.Dominators("A"); !reflect.DeepEqual(got, []string{"A"}) {
		t.Errorf("Dominators(A) = %v; want [A]", got)
	}
}

func TestEdgeAddRemoveMaintainsDomTree(t *testing.T) {
	g0 := New("A").AddEdge("A", "B").AddEdge("A", "C").AddEdge("B", "D")
	a0 := g0.Analyze()
	if got, _ := a0.ImmediateDominator("D"); got != "B" {
		t.Fatalf("before: idom(D) = %s; want B", got)
	}

	g1 := g0.AddEdge("C", "D")
	a1 := g1.Analyze()
	if got, _ := a1.ImmediateDominator("D"); got != "A" {
		t.Fatalf("after add: idom(D) = %s; want A", got)
	}
	if got := a1.Dominators("D"); !reflect.DeepEqual(got, []string{"A", "D"}) {
		t.Fatalf("after add: Dominators(D) = %v; want [A D]", got)
	}

	g2 := g1.RemoveEdge("C", "D")
	a2 := g2.Analyze()
	if got, _ := a2.ImmediateDominator("D"); got != "B" {
		t.Fatalf("after remove: idom(D) = %s; want B", got)
	}
	// Compare node lines, ignoring the version header.
	strip := func(s string) string { return s[strings.IndexByte(s, '\n')+1:] }
	if strip(a0.String()) != strip(a2.String()) {
		t.Errorf("remove did not restore analysis:\n%s\nvs\n%s", a0.String(), a2.String())
	}
}

func TestOldVersionsRemainReadable(t *testing.T) {
	g0 := New("A").AddEdge("A", "B").AddEdge("A", "C").AddEdge("B", "D")
	before := g0.Analyze().String()
	v0 := g0.Version()

	g1 := g0.AddEdge("C", "D")
	g2 := g1.RemoveEdge("A", "C").AddEdge("C", "E")
	if g1.Version() != v0+1 || g2.Version() != v0+3 {
		t.Errorf("versions: g0=%d g1=%d g2=%d", g0.Version(), g1.Version(), g2.Version())
	}
	if got := g0.Analyze().String(); got != before {
		t.Errorf("old version changed after mutations:\n%s\nvs\n%s", before, got)
	}
	if g0.HasEdge("C", "D") || g0.HasNode("E") {
		t.Error("mutations leaked into old version")
	}
	// No-op mutations keep the same version.
	if g0.AddEdge("A", "B") != g0 || g0.RemoveEdge("B", "C") != g0 || g0.AddNode("A") != g0 {
		t.Error("no-op mutation must return the same graph")
	}
}

func TestEvidenceDump(t *testing.T) {
	dump := buildDiamond().AddNode("Z").Analyze().String()
	for _, want := range []string{
		"graph version", "entry A",
		"D: idom=A doms={A D} DF={}",
		"B: idom=A doms={A B} DF={D}",
		"Z: unreachable",
	} {
		if !strings.Contains(dump, want) {
			t.Errorf("dump missing %q:\n%s", want, dump)
		}
	}
}
