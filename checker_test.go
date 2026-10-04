package workgroup

import "testing"

func TestCheckerAcyclic(t *testing.T) {
	chk := Checker{}
	if !chk.Acyclic(nil) {
		t.Fatal("empty edge set reported cyclic")
	}
	edges := [][2]string{{"a", "b"}, {"b", "c"}, {"a", "c"}}
	if !chk.Acyclic(edges) {
		t.Fatalf("DAG %v reported cyclic", edges)
	}
	if cyc := chk.Cycle(edges); cyc != nil {
		t.Fatalf("Cycle(%v) = %v, want nil", edges, cyc)
	}
}

func TestCheckerFindsCycle(t *testing.T) {
	chk := Checker{}
	edges := [][2]string{{"a", "b"}, {"b", "c"}, {"c", "a"}, {"d", "a"}}
	if chk.Acyclic(edges) {
		t.Fatalf("cyclic %v reported acyclic", edges)
	}
	cyc := chk.Cycle(edges)
	if len(cyc) < 2 || cyc[0] != cyc[len(cyc)-1] {
		t.Fatalf("Cycle = %v, want closed loop", cyc)
	}
	set := make(map[[2]string]bool)
	for _, e := range edges {
		set[e] = true
	}
	for i := 0; i+1 < len(cyc); i++ {
		if !set[[2]string{cyc[i], cyc[i+1]}] {
			t.Fatalf("cycle %v uses non-existent edge %s->%s", cyc, cyc[i], cyc[i+1])
		}
	}
}

func TestCheckerSelfLoop(t *testing.T) {
	chk := Checker{}
	edges := [][2]string{{"x", "x"}}
	if chk.Acyclic(edges) {
		t.Fatal("self loop reported acyclic")
	}
	if cyc := chk.Cycle(edges); len(cyc) == 0 {
		t.Fatal("Cycle returned no evidence for self loop")
	}
}
