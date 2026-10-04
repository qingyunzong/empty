package main

import (
	"reflect"
	"testing"
)

func mustParse(t *testing.T, s string) *History {
	t.Helper()
	h, err := ParseHistory(s)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return h
}

func edgeSet(g *Graph) map[string]bool {
	set := map[string]bool{}
	for _, e := range g.Edges {
		set[e.String()] = true
	}
	return set
}

// 经典三环例: T1->T2 (WR x), T2->T3 (RW x), T3->T1 (WR y)。
func TestCycleEdges(t *testing.T) {
	h := mustParse(t, "W1(x) W3(y) R1(y3) R2(x1) W3(x)")
	g := BuildGraph(h)
	want := map[string]bool{
		"T1 -WR(x)-> T2": true,
		"T2 -RW(x)-> T3": true,
		"T3 -WR(y)-> T1": true,
	}
	if got := edgeSet(g); !reflect.DeepEqual(got, want) {
		t.Fatalf("edges = %v, want %v", got, want)
	}
	sccs := g.SCCs()
	if len(sccs) != 1 || !reflect.DeepEqual(sccs[0], []int{1, 2, 3}) {
		t.Fatalf("sccs = %v", sccs)
	}
	cycle := g.CycleIn(sccs[0])
	if len(cycle) != 3 {
		t.Fatalf("cycle len = %d, want 3", len(cycle))
	}
	got := []string{cycle[0].String(), cycle[1].String(), cycle[2].String()}
	wantChain := []string{"T1 -WR(x)-> T2", "T2 -RW(x)-> T3", "T3 -WR(y)-> T1"}
	if !reflect.DeepEqual(got, wantChain) {
		t.Fatalf("cycle chain = %v, want %v", got, wantChain)
	}
}

// 版本序更旧的版本不会遮蔽读到的版本，不产生边。
func TestOlderVersionNoEdge(t *testing.T) {
	h := mustParse(t, "W1(x) W2(x) R3(x2)")
	g := BuildGraph(h)
	want := map[string]bool{
		"T2 -WR(x)-> T3": true,
	}
	if got := edgeSet(g); !reflect.DeepEqual(got, want) {
		t.Fatalf("edges = %v, want %v", got, want)
	}
	if len(g.SCCs()) != 0 {
		t.Fatal("expected acyclic")
	}
	order, rounds, ok := g.TopoMinID()
	if !ok || !reflect.DeepEqual(order, []int{1, 2, 3}) {
		t.Fatalf("order = %v ok=%v", order, ok)
	}
	if len(rounds) != 3 || rounds[0].Picked != 1 {
		t.Fatalf("rounds = %+v", rounds)
	}
}

// 回归: 旧版本写者 T1 与读者之间不应产生假环; 串行序 [T2,T1,T3] 有效。
func TestNoFalseCycleFromVersionOrder(t *testing.T) {
	h := mustParse(t, "W1(x) W2(x) R3(x2) W1(y) W2(z) R1(z2)")
	g := BuildGraph(h)
	if len(g.SCCs()) != 0 {
		t.Fatalf("false cycle, edges = %v", g.Edges)
	}
	order, _, ok := g.TopoMinID()
	if !ok || !reflect.DeepEqual(order, []int{2, 1, 3}) {
		t.Fatalf("order = %v ok=%v", order, ok)
	}
	if _, ok := Replay(h, order); !ok {
		t.Fatal("replay of topo order failed")
	}
}

// 每轮取候选最小 ID: 第 1 轮候选 {T1,T2} 应选 T1。
func TestTopoMinIDChoice(t *testing.T) {
	h := mustParse(t, "W2(x) W1(y) R3(y1) R3(x2)")
	g := BuildGraph(h)
	order, rounds, ok := g.TopoMinID()
	if !ok {
		t.Fatal("expected acyclic")
	}
	if !reflect.DeepEqual(order, []int{1, 2, 3}) {
		t.Fatalf("order = %v", order)
	}
	if !reflect.DeepEqual(rounds[0].Candidates, []int{1, 2}) || rounds[0].Picked != 1 {
		t.Fatalf("round0 = %+v", rounds[0])
	}
}

// 自读自写不应产生自环假环。
func TestSelfReadNoFalseCycle(t *testing.T) {
	h := mustParse(t, "W1(x) R1(x1) W2(x) R2(x2)")
	g := BuildGraph(h)
	if len(g.SCCs()) != 0 {
		t.Fatalf("false cycle, edges = %v", g.Edges)
	}
	order, _, ok := g.TopoMinID()
	if !ok || !reflect.DeepEqual(order, []int{1, 2}) {
		t.Fatalf("order = %v ok=%v", order, ok)
	}
}

// 无冲突边的历史。
func TestNoEdges(t *testing.T) {
	h := mustParse(t, "W1(x) W2(y)")
	g := BuildGraph(h)
	if len(g.Edges) != 0 {
		t.Fatalf("edges = %v, want none", g.Edges)
	}
	order, _, ok := g.TopoMinID()
	if !ok || !reflect.DeepEqual(order, []int{1, 2}) {
		t.Fatalf("order = %v", order)
	}
}
