package graphtest

import (
	"strings"
	"testing"
)

func TestVerifyChainAcceptsHonestOutput(t *testing.T) {
	g := pathGraph(t)
	c := sampleChain()
	actual, err := c.Apply(g)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if err := VerifyChain(g, actual, c); err != nil {
		t.Fatalf("honest output rejected: %v", err)
	}
}

func TestVerifyChainRejectsTamperedOutput(t *testing.T) {
	g := pathGraph(t)
	c := sampleChain()
	actual, err := c.Apply(g)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	// Tamper: add a spurious edge.
	if err := actual.AddEdge(11, 13); err != nil {
		t.Fatalf("AddEdge: %v", err)
	}
	if err := VerifyChain(g, actual, c); err == nil {
		t.Fatalf("tampered output accepted")
	}
	// Tamper: drop the isolated vertex.
	actual2, _ := c.Apply(g)
	delete(actual2.adj, 55)
	if err := VerifyChain(g, actual2, c); err == nil {
		t.Fatalf("output with a missing vertex accepted")
	}
}

func TestVerifyChainRejectsIllegalSteps(t *testing.T) {
	g := pathGraph(t)
	cases := []struct {
		name  string
		chain *Chain
		want  string
	}{
		{"non-bijective relabel", &Chain{Steps: []Transform{Relabel(map[int]int{1: 7, 2: 7, 3: 8})}}, "illegal relabel"},
		{"existing isolated vertex", &Chain{Steps: []Transform{AddIsolated(2)}}, "illegal add_isolated"},
		{"split non-edge", &Chain{Steps: []Transform{SplitEdge(1, 3, 90)}}, "illegal split_edge"},
		{"unknown kind", &Chain{Steps: []Transform{{Kind: "frobnicate"}}}, "unknown kind"},
		{"illegal after legal", &Chain{Steps: []Transform{AddIsolated(50), SplitEdge(1, 50, 90)}}, "step 1"},
	}
	for _, tc := range cases {
		// Whatever the claimed output is, the illegal chain must be rejected.
		if err := VerifyChain(g, g.Clone(), tc.chain); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: got %v, want rejection containing %q", tc.name, err, tc.want)
		}
		if err := VerifyChainShape(g, tc.chain); err == nil {
			t.Fatalf("%s: shape check accepted illegal chain", tc.name)
		}
	}
}

func TestVerifyCertificateAcceptsProperInverse(t *testing.T) {
	g := pathGraph(t)
	c := sampleChain()
	cert := Certificate{11: 1, 99: 3, 12: 2, 13: 1, 55: 1}
	if err := VerifyCertificate(g, c, cert); err != nil {
		t.Fatalf("proper certificate rejected: %v", err)
	}
}

func TestVerifyCertificateRejectsMonochromaticInverse(t *testing.T) {
	g := pathGraph(t)
	// Split edge (1,2) via 90. On the transformed graph, 1:A 90:B 2:A is
	// proper, but the inverse certificate colors the original edge (1,2)
	// monochromatically and must be rejected.
	c := &Chain{Steps: []Transform{SplitEdge(1, 2, 90)}}
	cert := Certificate{1: 1, 90: 2, 2: 1, 3: 2}
	if err := VerifyCertificate(g, c, cert); err == nil || !strings.Contains(err.Error(), "monochromatic") {
		t.Fatalf("got %v, want monochromatic rejection", err)
	}
}

func TestVerifyCertificateRejectsIllegalChain(t *testing.T) {
	g := pathGraph(t)
	c := &Chain{Steps: []Transform{SplitEdge(1, 3, 90)}}
	if err := VerifyCertificate(g, c, Certificate{1: 1, 2: 2, 3: 1}); err == nil {
		t.Fatalf("certificate on illegal chain accepted")
	}
}

func TestVerifyRandomChainsEndToEnd(t *testing.T) {
	g := NewGraph()
	for _, e := range [][2]int{{1, 2}, {2, 3}, {3, 4}, {4, 1}, {1, 3}} {
		if err := g.AddEdge(e[0], e[1]); err != nil {
			t.Fatalf("AddEdge: %v", err)
		}
	}
	for _, seed := range []int64{1, 7, 42, 2026, 987654321} {
		c, final, err := RandomChain(g, seed, 15)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		if err := VerifyChain(g, final, c); err != nil {
			t.Fatalf("seed %d: generated output failed verification: %v", seed, err)
		}
	}
}
