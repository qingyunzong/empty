package graphtest

import "fmt"

// This file contains the independent verifier. It deliberately re-implements
// the semantics of every transformation instead of calling Transform.Apply,
// so that a bug in the transformation library cannot mask itself: the actual
// output graph is judged by re-deriving the expected graph from the recorded
// chain and comparing, and certificates are checked only after inverse
// mapping onto the original graph.

// VerifyChain judges whether actual is exactly the graph produced by
// applying the recorded chain to orig. Every step is re-validated; an
// illegal transformation is rejected explicitly with a descriptive error.
func VerifyChain(orig, actual *Graph, chain *Chain) error {
	if orig == nil || actual == nil || chain == nil {
		return fmt.Errorf("graphtest: verify: nil argument")
	}
	cur := orig.Clone()
	for i, t := range chain.Steps {
		next, err := verifyStep(cur, t)
		if err != nil {
			return fmt.Errorf("graphtest: verify: step %d rejected: %w", i, err)
		}
		cur = next
	}
	if !cur.Equal(actual) {
		return fmt.Errorf("graphtest: verify: actual output does not match the graph derived from the recorded chain")
	}
	return nil
}

// verifyStep independently checks the legality of t on g and derives the
// resulting graph from scratch.
func verifyStep(g *Graph, t Transform) (*Graph, error) {
	switch t.Kind {
	case KindRelabel:
		if len(t.Perm) != g.NumVertices() {
			return nil, fmt.Errorf("illegal relabel: permutation size %d != vertex count %d", len(t.Perm), g.NumVertices())
		}
		image := make(map[int]struct{}, len(t.Perm))
		for _, v := range g.Vertices() {
			nv, ok := t.Perm[v]
			if !ok {
				return nil, fmt.Errorf("illegal relabel: vertex %d unmapped", v)
			}
			if _, dup := image[nv]; dup {
				return nil, fmt.Errorf("illegal relabel: image %d used twice", nv)
			}
			image[nv] = struct{}{}
		}
		h := NewGraph()
		for v := range image {
			h.AddVertex(v)
		}
		for _, e := range g.Edges() {
			if err := h.AddEdge(t.Perm[e.U], t.Perm[e.V]); err != nil {
				return nil, err
			}
		}
		return h, nil
	case KindAddIsolated:
		if len(t.Added) == 0 {
			return nil, fmt.Errorf("illegal add_isolated: empty vertex set")
		}
		h := g.Clone()
		seen := make(map[int]struct{}, len(t.Added))
		for _, v := range t.Added {
			if h.HasVertex(v) {
				return nil, fmt.Errorf("illegal add_isolated: vertex %d already present", v)
			}
			if _, dup := seen[v]; dup {
				return nil, fmt.Errorf("illegal add_isolated: duplicate vertex %d", v)
			}
			seen[v] = struct{}{}
			h.AddVertex(v)
		}
		return h, nil
	case KindSplitEdge:
		if !g.HasEdge(t.U, t.V) {
			return nil, fmt.Errorf("illegal split_edge: no edge (%d,%d)", t.U, t.V)
		}
		if g.HasVertex(t.W) {
			return nil, fmt.Errorf("illegal split_edge: midpoint %d already present", t.W)
		}
		h := g.Clone()
		delete(h.adj[t.U], t.V)
		delete(h.adj[t.V], t.U)
		h.AddVertex(t.W)
		if err := h.AddEdge(t.U, t.W); err != nil {
			return nil, err
		}
		if err := h.AddEdge(t.W, t.V); err != nil {
			return nil, err
		}
		return h, nil
	default:
		return nil, fmt.Errorf("illegal transform: unknown kind %q", string(t.Kind))
	}
}

// VerifyCertificate inverse-maps cert through the chain onto the original
// graph and checks that it is a proper coloring there: every vertex of orig
// must carry a label and no edge may be monochromatic. The certificate
// returned by a solver for the transformed instance is never trusted
// directly; only its inverse image on the original graph is judged.
func VerifyCertificate(orig *Graph, chain *Chain, cert Certificate) error {
	if orig == nil || chain == nil {
		return fmt.Errorf("graphtest: verify certificate: nil argument")
	}
	if err := VerifyChainShape(orig, chain); err != nil {
		return err
	}
	inv, err := chain.InverseCertificate(orig, cert)
	if err != nil {
		return fmt.Errorf("graphtest: verify certificate: %w", err)
	}
	for _, v := range orig.Vertices() {
		if _, ok := inv[v]; !ok {
			return fmt.Errorf("graphtest: verify certificate: vertex %d of the original graph has no label", v)
		}
	}
	for _, e := range orig.Edges() {
		if inv[e.U] == inv[e.V] {
			return fmt.Errorf("graphtest: verify certificate: edge (%d,%d) is monochromatic with label %d", e.U, e.V, inv[e.U])
		}
	}
	return nil
}

// VerifyChainShape checks that every recorded step is legal when applied in
// sequence to orig, without requiring the final output graph.
func VerifyChainShape(orig *Graph, chain *Chain) error {
	cur := orig.Clone()
	for i, t := range chain.Steps {
		next, err := verifyStep(cur, t)
		if err != nil {
			return fmt.Errorf("graphtest: verify: step %d rejected: %w", i, err)
		}
		cur = next
	}
	return nil
}
