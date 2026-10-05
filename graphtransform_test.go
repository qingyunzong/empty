package graphtransform_test

import (
	"errors"
	"math/rand"
	"testing"

	gt "graphtransform"
)

func sampleGraph() *gt.Graph {
	g := gt.NewGraph()
	g.AddEdge(1, 2)
	g.AddEdge(2, 3)
	g.AddEdge(3, 4)
	g.AddVertex(10) // already isolated
	return g
}

func TestRelabelPublicMapping(t *testing.T) {
	g := sampleGraph()
	perm := map[int]int{1: 100, 2: 200, 3: 300, 4: 400, 10: 1000}
	out, m, err := gt.Relabel(perm).Apply(g)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	for v, want := range perm {
		if m.VertexMap[v] != want {
			t.Errorf("VertexMap[%d] = %d, want %d", v, m.VertexMap[v], want)
		}
		if !out.HasVertex(want) {
			t.Errorf("output missing vertex %d", want)
		}
	}
	if len(m.AddedVertices) != 0 {
		t.Errorf("relabel added vertices: %v", m.AddedVertices)
	}
	for _, e := range g.Edges() {
		path := m.EdgeMap[e]
		if len(path) != 1 || path[0] != gt.NewEdge(perm[e.U], perm[e.V]) {
			t.Errorf("EdgeMap[%v] = %v", e, path)
		}
	}
	if out.Degree(1000) != 0 {
		t.Errorf("isolated vertex gained edges")
	}
}

func TestAddIsolatedPublicMapping(t *testing.T) {
	g := sampleGraph()
	out, m, err := gt.AddIsolated(50, 60).Apply(g)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	for _, v := range g.Vertices() {
		if m.VertexMap[v] != v {
			t.Errorf("VertexMap[%d] = %d, want identity", v, m.VertexMap[v])
		}
	}
	if len(m.AddedVertices) != 2 || m.AddedVertices[0] != 50 || m.AddedVertices[1] != 60 {
		t.Errorf("AddedVertices = %v", m.AddedVertices)
	}
	if out.Degree(50) != 0 || out.Degree(60) != 0 {
		t.Errorf("added vertices are not isolated")
	}
	if len(out.Vertices()) != len(g.Vertices())+2 {
		t.Errorf("vertex count = %d", len(out.Vertices()))
	}
}

func TestSubdividePublicMapping(t *testing.T) {
	g := sampleGraph()
	out, m, err := gt.Subdivide(2, 3, 99).Apply(g)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if out.HasEdge(2, 3) {
		t.Errorf("original edge still present")
	}
	if !out.HasEdge(2, 99) || !out.HasEdge(3, 99) {
		t.Errorf("subdivision path missing: %v", out)
	}
	path := m.EdgeMap[gt.NewEdge(2, 3)]
	if len(path) != 2 || path[0] != gt.NewEdge(2, 99) || path[1] != gt.NewEdge(3, 99) {
		t.Errorf("EdgeMap[2-3] = %v", path)
	}
	if got := m.EdgeMap[gt.NewEdge(1, 2)]; len(got) != 1 || got[0] != gt.NewEdge(1, 2) {
		t.Errorf("untouched edge remapped: %v", got)
	}
	if len(m.AddedVertices) != 1 || m.AddedVertices[0] != 99 {
		t.Errorf("AddedVertices = %v", m.AddedVertices)
	}
}

func TestChainComposedMapping(t *testing.T) {
	g := gt.NewGraph()
	g.AddEdge(1, 2)
	chain := gt.Chain{Transforms: []gt.Transform{
		gt.Subdivide(1, 2, 5),                     // 1-2 becomes 1-5-2
		gt.Relabel(map[int]int{1: 7, 2: 8, 5: 9}), // shift labels
		gt.AddIsolated(42),
	}}
	out, m, err := chain.Apply(g)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if m.VertexMap[1] != 7 || m.VertexMap[2] != 8 {
		t.Errorf("VertexMap = %v", m.VertexMap)
	}
	path := m.EdgeMap[gt.NewEdge(1, 2)]
	want := []gt.Edge{gt.NewEdge(7, 9), gt.NewEdge(8, 9)}
	if len(path) != 2 || path[0] != want[0] || path[1] != want[1] {
		t.Errorf("composed EdgeMap[1-2] = %v, want %v", path, want)
	}
	if len(m.AddedVertices) != 1 || m.AddedVertices[0] != 42 {
		t.Errorf("AddedVertices = %v", m.AddedVertices)
	}
	if !out.HasEdge(7, 9) || !out.HasEdge(8, 9) || !out.HasVertex(42) {
		t.Errorf("output graph wrong: %v", out)
	}
}

func TestRandomChainDeterministic(t *testing.T) {
	g := sampleGraph()
	c1 := gt.RandomChain(rand.New(rand.NewSource(7)), g, 12)
	c2 := gt.RandomChain(rand.New(rand.NewSource(7)), g, 12)
	c3 := gt.RandomChain(rand.New(rand.NewSource(8)), g, 12)
	o1, _, err1 := c1.Apply(g)
	o2, _, err2 := c2.Apply(g)
	o3, _, err3 := c3.Apply(g)
	if err1 != nil || err2 != nil || err3 != nil {
		t.Fatalf("Apply errors: %v %v %v", err1, err2, err3)
	}
	if !o1.Equal(o2) {
		t.Errorf("same seed produced different outputs")
	}
	if o1.Equal(o3) {
		t.Errorf("different seeds produced identical outputs (unlikely but non-fatal)")
	}
}

func TestVerifyAcceptsValidCertificate(t *testing.T) {
	g := sampleGraph()
	out, _, cert, err := gt.NewCertificate(g, 42, 15)
	if err != nil {
		t.Fatalf("NewCertificate: %v", err)
	}
	if err := gt.Verify(g, out, cert); err != nil {
		t.Fatalf("Verify rejected a valid certificate: %v", err)
	}
	if err := gt.VerifySeed(g, cert); err != nil {
		t.Fatalf("VerifySeed: %v", err)
	}
}

func TestVerifyRejectsTamperedOutput(t *testing.T) {
	g := sampleGraph()
	out, _, cert, err := gt.NewCertificate(g, 1, 10)
	if err != nil {
		t.Fatalf("NewCertificate: %v", err)
	}
	tampered := out.Clone()
	tampered.AddEdge(-1, -2)
	if err := gt.Verify(g, tampered, cert); !errors.Is(err, gt.ErrOutputMismatch) {
		t.Errorf("Verify(tampered) = %v, want ErrOutputMismatch", err)
	}
}

func TestVerifyRejectsIllegalTransforms(t *testing.T) {
	g := sampleGraph()
	cases := []struct {
		name string
		tr   gt.Transform
		want error
	}{
		{"relabel misses vertex", gt.Relabel(map[int]int{1: 5, 2: 6}), gt.ErrNotBijection},
		{"relabel collides", gt.Relabel(map[int]int{1: 5, 2: 5, 3: 7, 4: 8, 10: 9}), gt.ErrNotBijection},
		{"add existing vertex", gt.AddIsolated(1), gt.ErrVertexExists},
		{"add duplicate vertex", gt.AddIsolated(77, 77), gt.ErrVertexExists},
		{"subdivide missing edge", gt.Subdivide(1, 4, 90), gt.ErrEdgeMissing},
		{"subdivide with used vertex", gt.Subdivide(1, 2, 3), gt.ErrVertexNotFresh},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := tc.tr.Apply(g); !errors.Is(err, tc.want) {
				t.Errorf("Apply = %v, want %v", err, tc.want)
			}
			cert := gt.Certificate{Seed: 0, Chain: gt.Chain{Transforms: []gt.Transform{tc.tr}}}
			if err := gt.Verify(g, g, cert); !errors.Is(err, gt.ErrIllegalTransform) {
				t.Errorf("Verify = %v, want ErrIllegalTransform", err)
			}
			if err := gt.Verify(g, g, cert); !errors.Is(err, tc.want) {
				t.Errorf("Verify = %v, want wrapped %v", err, tc.want)
			}
		})
	}
}

func TestInverseRoundTrip(t *testing.T) {
	g := sampleGraph()
	chain := gt.RandomChain(rand.New(rand.NewSource(99)), g, 20)
	out, _, err := chain.Apply(g)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	restored, err := chain.InverseApply(out)
	if err != nil {
		t.Fatalf("InverseApply: %v", err)
	}
	if !restored.Equal(g) {
		t.Errorf("round trip failed: restored %v, want %v", restored, g)
	}
}

func TestInverseRejectsIllegalChains(t *testing.T) {
	// Added vertex is not isolated in the graph being inverted.
	g := gt.NewGraph()
	g.AddEdge(1, 2)
	g.AddEdge(1, 5)
	chain := gt.Chain{Transforms: []gt.Transform{gt.AddIsolated(5)}}
	if _, err := chain.InverseApply(g); !errors.Is(err, gt.ErrNotIsolated) {
		t.Errorf("InverseApply = %v, want ErrNotIsolated", err)
	}

	// Subdivision midpoint has wrong degree.
	g2 := gt.NewGraph()
	g2.AddEdge(1, 9)
	g2.AddEdge(9, 2)
	g2.AddEdge(9, 3)
	chain2 := gt.Chain{Transforms: []gt.Transform{gt.Subdivide(1, 2, 9)}}
	if _, err := chain2.InverseApply(g2); !errors.Is(err, gt.ErrNotMidpoint) {
		t.Errorf("InverseApply = %v, want ErrNotMidpoint", err)
	}

	// Relabel inverse cannot cover the vertex set.
	g3 := gt.NewGraph()
	g3.AddEdge(1, 2)
	chain3 := gt.Chain{Transforms: []gt.Transform{gt.Relabel(map[int]int{1: 10, 2: 20})}}
	if _, err := chain3.InverseApply(g3); !errors.Is(err, gt.ErrNotBijection) {
		t.Errorf("InverseApply = %v, want ErrNotBijection", err)
	}
}

func TestVerifySeedRejectsForeignChain(t *testing.T) {
	g := sampleGraph()
	_, _, cert, err := gt.NewCertificate(g, 5, 8)
	if err != nil {
		t.Fatalf("NewCertificate: %v", err)
	}
	// Replace the chain with one generated from a different seed.
	other := gt.RandomChain(rand.New(rand.NewSource(6)), g, 8)
	cert.Chain = other
	o1, _, _ := cert.Chain.Apply(g)
	o2, _, _ := gt.RandomChain(rand.New(rand.NewSource(5)), g, 8).Apply(g)
	if o1.Equal(o2) {
		t.Skip("chains coincidentally equal")
	}
	if err := gt.VerifySeed(g, cert); !errors.Is(err, gt.ErrSeedMismatch) {
		t.Errorf("VerifySeed = %v, want ErrSeedMismatch", err)
	}
}
