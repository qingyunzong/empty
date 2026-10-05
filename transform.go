package graphtransform

import (
	"errors"
	"fmt"
	"sort"
)

// Kind identifies a transformation type.
type Kind int

const (
	// RelabelKind permutes vertex labels by a bijection.
	RelabelKind Kind = iota
	// AddIsolatedKind adds fresh vertices with no edges.
	AddIsolatedKind
	// SubdivideKind replaces an edge u-v with the path u-w-v.
	SubdivideKind
)

func (k Kind) String() string {
	switch k {
	case RelabelKind:
		return "Relabel"
	case AddIsolatedKind:
		return "AddIsolated"
	case SubdivideKind:
		return "Subdivide"
	}
	return "Unknown"
}

// Legality errors returned when a transformation is invalid for a graph.
var (
	ErrNotBijection   = errors.New("relabeling is not a bijection of the vertex set")
	ErrVertexExists   = errors.New("added vertex already exists in the graph")
	ErrEdgeMissing    = errors.New("subdivided edge does not exist in the graph")
	ErrVertexNotFresh = errors.New("subdivision vertex already exists in the graph")
)

// Transform is a single graph transformation. The fields used depend on Kind:
//
//	Relabel:     Perm (old label -> new label), a bijection of the vertex set
//	AddIsolated: Added (fresh vertices to insert, isolated)
//	Subdivide:   Edge (existing edge) and NewVertex (fresh midpoint)
type Transform struct {
	Kind      Kind
	Perm      map[int]int
	Added     []int
	Edge      Edge
	NewVertex int
}

// Relabel builds a relabeling transform from a permutation.
func Relabel(perm map[int]int) Transform {
	return Transform{Kind: RelabelKind, Perm: perm}
}

// AddIsolated builds a transform adding the given isolated vertices.
func AddIsolated(vertices ...int) Transform {
	return Transform{Kind: AddIsolatedKind, Added: append([]int(nil), vertices...)}
}

// Subdivide builds a transform splitting edge u-v at a fresh vertex w.
func Subdivide(u, v, w int) Transform {
	return Transform{Kind: SubdivideKind, Edge: NewEdge(u, v), NewVertex: w}
}

// Mapping is the public result mapping of a transformation (or a chain):
// it describes how vertices and edges of the input graph appear in the
// output graph.
type Mapping struct {
	// VertexMap sends each input vertex to its output label.
	VertexMap map[int]int
	// AddedVertices lists output vertices with no preimage, sorted.
	AddedVertices []int
	// EdgeMap sends each input edge to the edge path representing it in
	// the output graph (a single edge unless it was subdivided).
	EdgeMap map[Edge][]Edge
}

// identityMapping builds the identity mapping for g.
func identityMapping(g *Graph) *Mapping {
	m := &Mapping{
		VertexMap: make(map[int]int),
		EdgeMap:   make(map[Edge][]Edge),
	}
	for _, v := range g.Vertices() {
		m.VertexMap[v] = v
	}
	for _, e := range g.Edges() {
		m.EdgeMap[e] = []Edge{e}
	}
	return m
}

// Validate checks that t is legal for g without mutating anything.
func (t Transform) Validate(g *Graph) error {
	switch t.Kind {
	case RelabelKind:
		if len(t.Perm) != len(g.Vertices()) {
			return fmt.Errorf("%w: permutation covers %d of %d vertices",
				ErrNotBijection, len(t.Perm), len(g.Vertices()))
		}
		seen := make(map[int]bool, len(t.Perm))
		for _, v := range g.Vertices() {
			w, ok := t.Perm[v]
			if !ok {
				return fmt.Errorf("%w: vertex %d has no image", ErrNotBijection, v)
			}
			if seen[w] {
				return fmt.Errorf("%w: label %d is the image of two vertices", ErrNotBijection, w)
			}
			seen[w] = true
		}
		return nil
	case AddIsolatedKind:
		seen := make(map[int]bool, len(t.Added))
		for _, v := range t.Added {
			if g.HasVertex(v) || seen[v] {
				return fmt.Errorf("%w: %d", ErrVertexExists, v)
			}
			seen[v] = true
		}
		return nil
	case SubdivideKind:
		if !g.HasEdge(t.Edge.U, t.Edge.V) {
			return fmt.Errorf("%w: %v", ErrEdgeMissing, t.Edge)
		}
		if g.HasVertex(t.NewVertex) {
			return fmt.Errorf("%w: %d", ErrVertexNotFresh, t.NewVertex)
		}
		return nil
	}
	return fmt.Errorf("unknown transformation kind %d", int(t.Kind))
}

// Apply validates t against g and returns the transformed graph together
// with the public result mapping. g is not mutated.
func (t Transform) Apply(g *Graph) (*Graph, *Mapping, error) {
	if err := t.Validate(g); err != nil {
		return nil, nil, fmt.Errorf("illegal %s transformation: %w", t.Kind, err)
	}
	out := g.Clone()
	m := &Mapping{VertexMap: make(map[int]int), EdgeMap: make(map[Edge][]Edge)}
	switch t.Kind {
	case RelabelKind:
		out = NewGraph()
		for _, v := range g.Vertices() {
			w := t.Perm[v]
			out.AddVertex(w)
			m.VertexMap[v] = w
		}
		for _, e := range g.Edges() {
			ne := NewEdge(t.Perm[e.U], t.Perm[e.V])
			out.AddEdge(ne.U, ne.V)
			m.EdgeMap[e] = []Edge{ne}
		}
	case AddIsolatedKind:
		for _, v := range g.Vertices() {
			m.VertexMap[v] = v
		}
		for _, e := range g.Edges() {
			m.EdgeMap[e] = []Edge{e}
		}
		for _, v := range t.Added {
			out.AddVertex(v)
		}
		m.AddedVertices = append([]int(nil), t.Added...)
		sort.Ints(m.AddedVertices)
	case SubdivideKind:
		for _, v := range g.Vertices() {
			m.VertexMap[v] = v
		}
		u, v, w := t.Edge.U, t.Edge.V, t.NewVertex
		out.RemoveEdge(u, v)
		out.AddEdge(u, w)
		out.AddEdge(w, v)
		for _, e := range g.Edges() {
			if e == t.Edge {
				m.EdgeMap[e] = []Edge{NewEdge(u, w), NewEdge(w, v)}
			} else {
				m.EdgeMap[e] = []Edge{e}
			}
		}
		m.AddedVertices = []int{w}
	}
	return out, m, nil
}
