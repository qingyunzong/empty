package graphtest

import "fmt"

// Kind identifies a graph transformation type.
type Kind string

const (
	// KindRelabel permutes vertex labels by a bijection.
	KindRelabel Kind = "relabel"
	// KindAddIsolated adds isolated (irrelevant) vertices.
	KindAddIsolated Kind = "add_isolated"
	// KindSplitEdge replaces edge (U,V) with (U,W) and (W,V).
	KindSplitEdge Kind = "split_edge"
)

// Transform is a single, serializable graph transformation step.
// Exactly the fields relevant to Kind are used:
//
//	relabel:      Perm (old label -> new label), a bijection on V(g)
//	add_isolated: Added (fresh vertex labels)
//	split_edge:   U, V (existing edge), W (fresh midpoint vertex)
type Transform struct {
	Kind  Kind        `json:"kind"`
	Perm  map[int]int `json:"perm,omitempty"`
	Added []int       `json:"added,omitempty"`
	U     int         `json:"u,omitempty"`
	V     int         `json:"v,omitempty"`
	W     int         `json:"w,omitempty"`
}

// Relabel builds a relabeling transform from a permutation old -> new.
func Relabel(perm map[int]int) Transform {
	p := make(map[int]int, len(perm))
	for k, v := range perm {
		p[k] = v
	}
	return Transform{Kind: KindRelabel, Perm: p}
}

// AddIsolated builds an irrelevant-vertex-addition transform.
func AddIsolated(vertices ...int) Transform {
	return Transform{Kind: KindAddIsolated, Added: append([]int(nil), vertices...)}
}

// SplitEdge builds an edge-split transform: edge (u,v) becomes (u,w),(w,v).
func SplitEdge(u, v, w int) Transform {
	return Transform{Kind: KindSplitEdge, U: u, V: v, W: w}
}

// Validate checks that t is a legal transformation of g, returning a
// descriptive error otherwise. Illegal transformations are always rejected
// explicitly, never silently applied.
func (t Transform) Validate(g *Graph) error {
	switch t.Kind {
	case KindRelabel:
		if len(t.Perm) != g.NumVertices() {
			return fmt.Errorf("graphtest: illegal relabel: permutation covers %d vertices, graph has %d", len(t.Perm), g.NumVertices())
		}
		image := make(map[int]int, len(t.Perm))
		for _, v := range g.Vertices() {
			nv, ok := t.Perm[v]
			if !ok {
				return fmt.Errorf("graphtest: illegal relabel: vertex %d has no image", v)
			}
			if prev, dup := image[nv]; dup {
				return fmt.Errorf("graphtest: illegal relabel: vertices %d and %d share image %d (not a bijection)", prev, v, nv)
			}
			image[nv] = v
		}
		return nil
	case KindAddIsolated:
		if len(t.Added) == 0 {
			return fmt.Errorf("graphtest: illegal add_isolated: no vertices given")
		}
		seen := make(map[int]struct{}, len(t.Added))
		for _, v := range t.Added {
			if g.HasVertex(v) {
				return fmt.Errorf("graphtest: illegal add_isolated: vertex %d already exists", v)
			}
			if _, dup := seen[v]; dup {
				return fmt.Errorf("graphtest: illegal add_isolated: duplicate vertex %d", v)
			}
			seen[v] = struct{}{}
		}
		return nil
	case KindSplitEdge:
		if !g.HasEdge(t.U, t.V) {
			return fmt.Errorf("graphtest: illegal split_edge: edge (%d,%d) does not exist", t.U, t.V)
		}
		if g.HasVertex(t.W) {
			return fmt.Errorf("graphtest: illegal split_edge: midpoint %d already exists", t.W)
		}
		return nil
	default:
		return fmt.Errorf("graphtest: illegal transform: unknown kind %q", string(t.Kind))
	}
}

// Apply validates t against g and returns the transformed graph.
// g is not modified.
func (t Transform) Apply(g *Graph) (*Graph, error) {
	if err := t.Validate(g); err != nil {
		return nil, err
	}
	h := NewGraph()
	switch t.Kind {
	case KindRelabel:
		for _, v := range g.Vertices() {
			h.AddVertex(t.Perm[v])
		}
		for _, e := range g.Edges() {
			if err := h.AddEdge(t.Perm[e.U], t.Perm[e.V]); err != nil {
				return nil, err
			}
		}
	case KindAddIsolated:
		h = g.Clone()
		for _, v := range t.Added {
			h.AddVertex(v)
		}
	case KindSplitEdge:
		h = g.Clone()
		u, v := t.U, t.V
		delete(h.adj[u], v)
		delete(h.adj[v], u)
		h.AddVertex(t.W)
		if err := h.AddEdge(u, t.W); err != nil {
			return nil, err
		}
		if err := h.AddEdge(t.W, v); err != nil {
			return nil, err
		}
	}
	return h, nil
}

// ForwardMap returns the public result mapping from vertices of the
// original graph to vertices of the transformed graph.
func (t Transform) ForwardMap(g *Graph) (map[int]int, error) {
	if err := t.Validate(g); err != nil {
		return nil, err
	}
	m := make(map[int]int, g.NumVertices())
	switch t.Kind {
	case KindRelabel:
		for v, nv := range t.Perm {
			m[v] = nv
		}
	default: // add_isolated and split_edge keep existing labels
		for _, v := range g.Vertices() {
			m[v] = v
		}
	}
	return m, nil
}

// InverseMap returns the mapping from vertices of the transformed graph
// back to vertices of the original graph. Vertices introduced by the
// transform (isolated additions, split midpoints) have no preimage and are
// absent from the map.
func (t Transform) InverseMap(g *Graph) (map[int]int, error) {
	if err := t.Validate(g); err != nil {
		return nil, err
	}
	m := make(map[int]int, g.NumVertices())
	switch t.Kind {
	case KindRelabel:
		for old, nv := range t.Perm {
			m[nv] = old
		}
	default:
		for _, v := range g.Vertices() {
			m[v] = v
		}
	}
	return m, nil
}
