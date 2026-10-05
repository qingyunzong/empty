package graphtransform

import (
	"errors"
	"fmt"
	"math/rand"
)

// Inverse-legality errors returned while undoing a transformation chain.
var (
	ErrNotIsolated  = errors.New("vertex to remove is not isolated")
	ErrNotMidpoint  = errors.New("subdivision vertex is not a degree-2 midpoint of its edge endpoints")
	ErrEdgeConflict = errors.New("restored edge already exists in the graph")
)

// Chain is an ordered sequence of transformations.
type Chain struct {
	Transforms []Transform
}

// Apply replays the chain on a clone of g, validating every step, and
// returns the final graph plus the composed public result mapping.
func (c Chain) Apply(g *Graph) (*Graph, *Mapping, error) {
	cur := g.Clone()
	composed := identityMapping(g)
	for i, t := range c.Transforms {
		next, m, err := t.Apply(cur)
		if err != nil {
			return nil, nil, fmt.Errorf("step %d: %w", i, err)
		}
		composed = composeMappings(composed, m)
		cur = next
	}
	return cur, composed, nil
}

// composeMappings yields the mapping of "first a, then b".
func composeMappings(a, b *Mapping) *Mapping {
	out := &Mapping{
		VertexMap:     make(map[int]int, len(a.VertexMap)),
		AddedVertices: append([]int(nil), b.AddedVertices...),
		EdgeMap:       make(map[Edge][]Edge, len(a.EdgeMap)),
	}
	for v, mid := range a.VertexMap {
		if w, ok := b.VertexMap[mid]; ok {
			out.VertexMap[v] = w
		} else {
			// mid was added by an earlier step and is untouched by b.
			out.VertexMap[v] = mid
		}
	}
	for e, path := range a.EdgeMap {
		var newPath []Edge
		for _, pe := range path {
			if mapped, ok := b.EdgeMap[pe]; ok {
				newPath = append(newPath, mapped...)
			} else {
				newPath = append(newPath, pe)
			}
		}
		out.EdgeMap[e] = newPath
	}
	return out
}

// InverseApply undoes the chain in reverse order on a clone of g,
// validating every inverse step. It is the inverse of Apply: if
// out, _, err := c.Apply(g) succeeds, then c.InverseApply(out) yields a
// graph equal to g.
func (c Chain) InverseApply(g *Graph) (*Graph, error) {
	cur := g.Clone()
	for i := len(c.Transforms) - 1; i >= 0; i-- {
		t := c.Transforms[i]
		next, err := inverseStep(cur, t)
		if err != nil {
			return nil, fmt.Errorf("inverse step %d: %w", i, err)
		}
		cur = next
	}
	return cur, nil
}

func inverseStep(g *Graph, t Transform) (*Graph, error) {
	out := g.Clone()
	switch t.Kind {
	case RelabelKind:
		inv := make(map[int]int, len(t.Perm))
		for v, w := range t.Perm {
			if _, dup := inv[w]; dup {
				return nil, fmt.Errorf("illegal %s transformation: %w: label %d duplicated",
					t.Kind, ErrNotBijection, w)
			}
			inv[w] = v
		}
		if len(inv) != len(out.Vertices()) {
			return nil, fmt.Errorf("illegal %s transformation: %w: vertex count mismatch",
				t.Kind, ErrNotBijection)
		}
		for _, w := range out.Vertices() {
			if _, ok := inv[w]; !ok {
				return nil, fmt.Errorf("illegal %s transformation: %w: vertex %d has no preimage",
					t.Kind, ErrNotBijection, w)
			}
		}
		res := NewGraph()
		for _, w := range out.Vertices() {
			res.AddVertex(inv[w])
		}
		for _, e := range out.Edges() {
			res.AddEdge(inv[e.U], inv[e.V])
		}
		return res, nil
	case AddIsolatedKind:
		for _, v := range t.Added {
			if !out.HasVertex(v) {
				return nil, fmt.Errorf("illegal inverse of %s: vertex %d missing", t.Kind, v)
			}
			if out.Degree(v) != 0 {
				return nil, fmt.Errorf("illegal inverse of %s: %w: %d", t.Kind, ErrNotIsolated, v)
			}
		}
		for _, v := range t.Added {
			out.RemoveVertex(v)
		}
		return out, nil
	case SubdivideKind:
		u, v, w := t.Edge.U, t.Edge.V, t.NewVertex
		if !out.HasVertex(w) || out.Degree(w) != 2 ||
			!out.HasEdge(u, w) || !out.HasEdge(w, v) {
			return nil, fmt.Errorf("illegal inverse of %s: %w: %d", t.Kind, ErrNotMidpoint, w)
		}
		if out.HasEdge(u, v) {
			return nil, fmt.Errorf("illegal inverse of %s: %w: %v", t.Kind, ErrEdgeConflict, t.Edge)
		}
		out.RemoveVertex(w)
		out.AddEdge(u, v)
		return out, nil
	}
	return nil, fmt.Errorf("unknown transformation kind %d", int(t.Kind))
}

// RandomChain deterministically generates a legal chain of nSteps
// transformations for g using r. The same seed therefore always produces
// the same chain and the same final graph.
func RandomChain(r *rand.Rand, g *Graph, nSteps int) Chain {
	cur := g.Clone()
	chain := Chain{}
	for i := 0; i < nSteps; i++ {
		var t Transform
		switch r.Intn(3) {
		case 0:
			vs := cur.Vertices()
			perm := make(map[int]int, len(vs))
			shuffled := r.Perm(len(vs))
			for j, idx := range shuffled {
				perm[vs[j]] = vs[idx]
			}
			t = Relabel(perm)
		case 1:
			count := 1 + r.Intn(3)
			added := make([]int, 0, count)
			seen := make(map[int]bool, count)
			for len(added) < count {
				v := r.Intn(1 << 30)
				if !cur.HasVertex(v) && !seen[v] {
					seen[v] = true
					added = append(added, v)
				}
			}
			t = AddIsolated(added...)
		case 2:
			edges := cur.Edges()
			if len(edges) == 0 {
				continue
			}
			e := edges[r.Intn(len(edges))]
			w := r.Intn(1 << 30)
			for cur.HasVertex(w) {
				w = r.Intn(1 << 30)
			}
			t = Subdivide(e.U, e.V, w)
		}
		next, _, err := t.Apply(cur)
		if err != nil {
			continue
		}
		cur = next
		chain.Transforms = append(chain.Transforms, t)
	}
	return chain
}
