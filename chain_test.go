package graphtest

import (
	"bytes"
	"strings"
	"testing"
)

func sampleChain() *Chain {
	return &Chain{
		Seed: 42,
		Steps: []Transform{
			AddIsolated(50),
			SplitEdge(1, 2, 90),
			Relabel(map[int]int{1: 11, 2: 12, 3: 13, 50: 55, 90: 99}),
		},
	}
}

func TestChainApplyAndForwardMap(t *testing.T) {
	g := pathGraph(t)
	c := sampleChain()
	final, err := c.Apply(g)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	// After the chain: path 11-99-12-13 plus isolated 55.
	for _, e := range [][2]int{{11, 99}, {99, 12}, {12, 13}} {
		if !final.HasEdge(e[0], e[1]) {
			t.Fatalf("expected edge %v missing in %v", e, final.Edges())
		}
	}
	if !final.HasVertex(55) || len(final.Neighbors(55)) != 0 {
		t.Fatalf("isolated vertex 55 missing or not isolated")
	}
	fwd, err := c.ForwardMap(g)
	if err != nil {
		t.Fatalf("ForwardMap: %v", err)
	}
	want := map[int]int{1: 11, 2: 12, 3: 13}
	for v, w := range want {
		if fwd[v] != w {
			t.Fatalf("forward map: got %v, want %v", fwd, want)
		}
	}
}

func TestChainIllegalStepRejected(t *testing.T) {
	g := pathGraph(t)
	c := &Chain{Seed: 1, Steps: []Transform{
		AddIsolated(50),
		SplitEdge(1, 50, 90), // (1,50) is not an edge: 50 is isolated
	}}
	if _, err := c.Apply(g); err == nil || !strings.Contains(err.Error(), "step 1") {
		t.Fatalf("got %v, want rejection naming step 1", err)
	}
}

func TestChainSaveLoadRoundTrip(t *testing.T) {
	c := sampleChain()
	var buf bytes.Buffer
	if err := c.Save(&buf); err != nil {
		t.Fatalf("Save: %v", err)
	}
	back, err := LoadChain(&buf)
	if err != nil {
		t.Fatalf("LoadChain: %v", err)
	}
	if back.Seed != c.Seed || len(back.Steps) != len(c.Steps) {
		t.Fatalf("round trip mismatch: %+v", back)
	}
	g := pathGraph(t)
	a, err := c.Apply(g)
	if err != nil {
		t.Fatalf("Apply original: %v", err)
	}
	b, err := back.Apply(g)
	if err != nil {
		t.Fatalf("Apply loaded: %v", err)
	}
	if !a.Equal(b) {
		t.Fatalf("loaded chain produces a different graph")
	}
}

func TestInverseCertificate(t *testing.T) {
	g := pathGraph(t)
	c := sampleChain()
	// Proper coloring of the transformed graph: 11:A 99:C 12:B 13:A 55:A.
	cert := Certificate{11: 1, 99: 3, 12: 2, 13: 1, 55: 1}
	inv, err := c.InverseCertificate(g, cert)
	if err != nil {
		t.Fatalf("InverseCertificate: %v", err)
	}
	want := Certificate{1: 1, 2: 2, 3: 1}
	if len(inv) != len(want) {
		t.Fatalf("got %v, want %v", inv, want)
	}
	for v, l := range want {
		if inv[v] != l {
			t.Fatalf("got %v, want %v", inv, want)
		}
	}
	// A certificate missing a vertex must be rejected.
	if _, err := c.InverseCertificate(g, Certificate{11: 1}); err == nil {
		t.Fatalf("incomplete certificate accepted")
	}
}

func TestRandomChainReproducible(t *testing.T) {
	g := pathGraph(t)
	c1, f1, err := RandomChain(g, 2026, 12)
	if err != nil {
		t.Fatalf("RandomChain: %v", err)
	}
	c2, f2, err := RandomChain(g, 2026, 12)
	if err != nil {
		t.Fatalf("RandomChain: %v", err)
	}
	if !f1.Equal(f2) {
		t.Fatalf("same seed produced different graphs")
	}
	var b1, b2 bytes.Buffer
	if err := c1.Save(&b1); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := c2.Save(&b2); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if b1.String() != b2.String() {
		t.Fatalf("same seed produced different records")
	}
	if c1.Seed != 2026 || len(c1.Steps) != 12 {
		t.Fatalf("record does not contain seed and steps: %+v", c1)
	}
	// The recorded chain must replay to the same graph.
	replay, err := c1.Apply(g)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if !replay.Equal(f1) {
		t.Fatalf("recorded chain does not replay to the generated graph")
	}
}
