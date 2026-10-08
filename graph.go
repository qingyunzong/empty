// Package ratiograph maintains an undirected graph whose edges constrain
// ratios between positive-rational vertex variables: an edge (u, v, a, b)
// asserts x_u / x_v = a / b.
//
// Every connected component admits, when consistent, a unique ray of
// positive-rational solutions; the library reports it as the unique
// simplest positive-integer ratio vector (coprime weights). Inconsistent
// components are witnessed by a cycle whose ratio product differs from 1,
// returned as a Certificate.
//
// Mutations happen through Apply, which atomically applies a batch of edge
// additions and removals: the batch is validated on a private copy with a
// full-graph potential-propagation pass, and committed only when the whole
// graph is consistent.
package ratiograph

import (
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strings"
)

// Edge constrains two vertex variables: x_U / x_V = Num / Den.
// Num and Den must be positive integers.
type Edge struct {
	U, V     int
	Num, Den int64
}

func (e Edge) String() string {
	return fmt.Sprintf("x%d/x%d=%d/%d", e.U, e.V, e.Num, e.Den)
}

func (e Edge) validate() error {
	if e.Num <= 0 || e.Den <= 0 {
		return fmt.Errorf("ratiograph: edge %s: ratio must be positive", e)
	}
	return nil
}

// canonical reduces the ratio and normalizes direction so that logically
// identical constraints map to the same key.
func (e Edge) canonical() Edge {
	g := gcd64(e.Num, e.Den)
	e.Num /= g
	e.Den /= g
	if e.U > e.V {
		e.U, e.V = e.V, e.U
		e.Num, e.Den = e.Den, e.Num
	}
	return e
}

func gcd64(a, b int64) int64 {
	if a < 0 {
		a = -a
	}
	if b < 0 {
		b = -b
	}
	for b != 0 {
		a, b = b, a%b
	}
	return a
}

// Step is one directed hop of a cycle certificate: x_To = x_From * Mult,
// witnessed by Edge.
type Step struct {
	From, To int
	Edge     Edge
	Mult     *big.Rat
}

// Certificate witnesses inconsistency: a directed closed walk whose edge
// multipliers multiply to Product != 1, which no assignment of positive
// rationals can satisfy.
type Certificate struct {
	Steps   []Step
	Product *big.Rat
}

func (c *Certificate) String() string {
	var b strings.Builder
	b.WriteString("inconsistent cycle, product=")
	b.WriteString(c.Product.RatString())
	for _, s := range c.Steps {
		fmt.Fprintf(&b, "\n  x%d --[%s]--> x%d (x%s)", s.From, s.Edge, s.To, s.Mult.RatString())
	}
	return b.String()
}

// Component is one connected component's simplest positive-integer ratio
// vector: Weights[i] is the weight of Vertices[i], and the weights are
// positive, coprime as a set, and unique up to the component's ray.
type Component struct {
	Vertices []int
	Weights  []*big.Int
}

// Weight returns the component's integer weight for vertex v, or nil if v
// is not in the component.
func (c Component) Weight(v int) *big.Int {
	for i, u := range c.Vertices {
		if u == v {
			return c.Weights[i]
		}
	}
	return nil
}

// ErrEdgeNotFound is returned (wrapped) by Apply when a removal names an
// edge that is not present; the batch is discarded.
var ErrEdgeNotFound = errors.New("ratiograph: edge not found")

type term struct {
	to   int
	edge Edge // canonical
}

// mult returns m such that x_(t.to) = x_from * m.
func (t term) mult(from int) *big.Rat {
	if from == t.edge.U {
		return big.NewRat(t.edge.Den, t.edge.Num)
	}
	return big.NewRat(t.edge.Num, t.edge.Den)
}

// Graph is a ratio-constraint graph. The zero value is not ready for use;
// construct with New.
type Graph struct {
	edges map[Edge]struct{}
	adj   map[int][]term
}

// New returns an empty graph.
func New() *Graph {
	return &Graph{
		edges: make(map[Edge]struct{}),
		adj:   make(map[int][]term),
	}
}

func (g *Graph) clone() *Graph {
	h := New()
	for e := range g.edges {
		h.edges[e] = struct{}{}
	}
	for v, ts := range g.adj {
		h.adj[v] = append([]term(nil), ts...)
	}
	return h
}

// Edges returns the current canonical edge set, sorted.
func (g *Graph) Edges() []Edge {
	out := make([]Edge, 0, len(g.edges))
	for e := range g.edges {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].U != out[j].U {
			return out[i].U < out[j].U
		}
		if out[i].V != out[j].V {
			return out[i].V < out[j].V
		}
		if out[i].Num != out[j].Num {
			return out[i].Num < out[j].Num
		}
		return out[i].Den < out[j].Den
	})
	return out
}

func (g *Graph) add(e Edge) {
	e = e.canonical()
	if _, ok := g.edges[e]; ok {
		return
	}
	g.edges[e] = struct{}{}
	g.adj[e.U] = append(g.adj[e.U], term{to: e.V, edge: e})
	g.adj[e.V] = append(g.adj[e.V], term{to: e.U, edge: e})
}

func (g *Graph) remove(e Edge) bool {
	e = e.canonical()
	if _, ok := g.edges[e]; !ok {
		return false
	}
	delete(g.edges, e)
	g.adj[e.U] = removeTerm(g.adj[e.U], e)
	g.adj[e.V] = removeTerm(g.adj[e.V], e)
	return true
}

func removeTerm(ts []term, e Edge) []term {
	for i, t := range ts {
		if t.edge == e {
			return append(ts[:i], ts[i+1:]...)
		}
	}
	return ts
}

func (g *Graph) sortedVertices() []int {
	vs := make([]int, 0, len(g.adj))
	for v := range g.adj {
		vs = append(vs, v)
	}
	sort.Ints(vs)
	return vs
}

// treeEdge records how BFS first reached a node: x_node = x_parent * mult.
type treeEdge struct {
	parent int
	mult   *big.Rat
	edge   Edge
}

// potentials propagates potentials over the whole graph: each component
// root gets 1 and every edge imposes its ratio. It returns either a
// per-vertex potential assignment satisfying all edges, or a cycle
// certificate for the first contradiction found.
func (g *Graph) potentials() (map[int]*big.Rat, *Certificate) {
	pot := make(map[int]*big.Rat)
	up := make(map[int]treeEdge)

	for _, s := range g.sortedVertices() {
		if _, ok := pot[s]; ok {
			continue
		}
		pot[s] = big.NewRat(1, 1)
		queue := []int{s}
		for len(queue) > 0 {
			u := queue[0]
			queue = queue[1:]
			for _, t := range g.adj[u] {
				m := t.mult(u)
				want := new(big.Rat).Mul(pot[u], m)
				if _, ok := pot[t.to]; !ok {
					pot[t.to] = want
					up[t.to] = treeEdge{parent: u, mult: m, edge: t.edge}
					queue = append(queue, t.to)
					continue
				}
				if pot[t.to].Cmp(want) != 0 {
					return nil, buildCertificate(u, t.to, t.edge, m, up)
				}
			}
		}
	}
	return pot, nil
}

// buildCertificate assembles a closed walk for the conflicting edge
// u --e--> v (x_v = x_u * m): cross the edge, climb the BFS tree from v to
// the lowest common ancestor w, then descend the tree from w back to u.
func buildCertificate(u, v int, e Edge, m *big.Rat, up map[int]treeEdge) *Certificate {
	pathU := []int{u}
	inU := map[int]bool{u: true}
	for {
		te, ok := up[pathU[len(pathU)-1]]
		if !ok {
			break
		}
		pathU = append(pathU, te.parent)
		inU[te.parent] = true
	}
	pathV := []int{v}
	for !inU[pathV[len(pathV)-1]] {
		pathV = append(pathV, up[pathV[len(pathV)-1]].parent)
	}
	w := pathV[len(pathV)-1]

	steps := []Step{{From: u, To: v, Edge: e, Mult: m}}
	prod := new(big.Rat).Set(m)

	// Climb from v up to w: invert each tree multiplier.
	for i := 0; i+1 < len(pathV); i++ {
		c := pathV[i]
		te := up[c]
		inv := new(big.Rat).Inv(te.mult)
		steps = append(steps, Step{From: c, To: te.parent, Edge: te.edge, Mult: inv})
		prod.Mul(prod, inv)
	}
	// Descend from w down to u along pathU.
	for i := len(pathU) - 1; i >= 0; i-- {
		if pathU[i] == w {
			for j := i - 1; j >= 0; j-- {
				c := pathU[j]
				te := up[c]
				down := new(big.Rat).Set(te.mult)
				steps = append(steps, Step{From: te.parent, To: c, Edge: te.edge, Mult: down})
				prod.Mul(prod, down)
			}
			break
		}
	}
	return &Certificate{Steps: steps, Product: prod}
}

// integerVector scales the component's rational potentials to the simplest
// positive integers: multiply by the LCM of denominators, divide by the GCD.
func integerVector(verts []int, pot map[int]*big.Rat) []*big.Int {
	lcm := big.NewInt(1)
	for _, v := range verts {
		d := new(big.Int).Set(pot[v].Denom())
		g := new(big.Int).GCD(nil, nil, lcm, d)
		lcm.Quo(lcm, g).Mul(lcm, d)
	}
	weights := make([]*big.Int, len(verts))
	gcd := new(big.Int)
	for i, v := range verts {
		w := new(big.Rat).Mul(pot[v], new(big.Rat).SetInt(lcm))
		weights[i] = w.Num()
		gcd.GCD(nil, nil, gcd, weights[i])
	}
	for i := range weights {
		weights[i].Quo(weights[i], gcd)
	}
	return weights
}

// components groups vertices and emits each component's integer vector.
func (g *Graph) components(pot map[int]*big.Rat) []Component {
	visited := make(map[int]bool)
	var comps []Component
	for _, s := range g.sortedVertices() {
		if visited[s] {
			continue
		}
		var verts []int
		queue := []int{s}
		visited[s] = true
		for len(queue) > 0 {
			u := queue[0]
			queue = queue[1:]
			verts = append(verts, u)
			for _, t := range g.adj[u] {
				if !visited[t.to] {
					visited[t.to] = true
					queue = append(queue, t.to)
				}
			}
		}
		sort.Ints(verts)
		comps = append(comps, Component{Vertices: verts, Weights: integerVector(verts, pot)})
	}
	return comps
}

// Verify runs the full-graph potential-propagation model over the current
// graph and returns every component's simplest positive-integer ratio
// vector, or a cycle certificate if any component is inconsistent.
func (g *Graph) Verify() ([]Component, *Certificate) {
	pot, cert := g.potentials()
	if cert != nil {
		return nil, cert
	}
	return g.components(pot), nil
}

// Apply atomically applies a batch: removals first, then additions. The
// batch runs on a private copy and is committed only if the whole graph
// verifies under potential propagation. On inconsistency the graph is left
// untouched and a cycle certificate is returned; on invalid input an error
// is returned and the graph is left untouched.
func (g *Graph) Apply(adds, removes []Edge) ([]Component, *Certificate, error) {
	for _, e := range adds {
		if err := e.validate(); err != nil {
			return nil, nil, err
		}
	}
	for _, e := range removes {
		if err := e.validate(); err != nil {
			return nil, nil, err
		}
	}
	next := g.clone()
	for _, e := range removes {
		if !next.remove(e) {
			return nil, nil, fmt.Errorf("%w: %s", ErrEdgeNotFound, e.canonical())
		}
	}
	for _, e := range adds {
		next.add(e)
	}
	pot, cert := next.potentials()
	if cert != nil {
		return nil, cert, nil
	}
	comps := next.components(pot)
	g.edges, g.adj = next.edges, next.adj
	return comps, nil, nil
}
