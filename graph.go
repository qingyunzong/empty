package dataeng

import (
	"errors"
	"fmt"
	"math/big"
)

// MaxNodes is the largest number of observations supported by one graph.
const MaxNodes = 64

// Edge is a user-supplied precedence edge. From -> To means x_From <= x_To.
// EdgeID identifies the source record; duplicate (From,To) pairs are merged
// while all of their EdgeIDs are retained for provenance mapping.
type Edge struct {
	EdgeID string
	From   string
	To     string
}

// dedupEdge is one unique ordered pair after de-duplication.
type dedupEdge struct {
	from      int
	to        int
	sourceIDs []string
}

// Graph is a validated, reusable partial order. Its internals are immutable
// after [Compile] returns: solving with new y and w never mutates the axioms.
type Graph struct {
	ids   []string
	index map[string]int
	// Unique edges in first-seen order of their underlying pair.
	edges []dedupEdge
	// adj[u] lists unique successors of u, in edge order.
	adj [][]int
}

// Compile validates node and edge metadata and builds a reusable DAG.
//
// It rejects more than MaxNodes nodes, empty or duplicated node IDs, nil or
// non-positive weights, unknown edge endpoints, self loops, empty or
// duplicated edge IDs, and directed cycles. Redundant transitive edges are
// allowed; repeated (From,To) pairs are de-duplicated but every original
// EdgeID is kept on the merged edge.
func Compile(ids []string, y []*big.Rat, w []*big.Rat, edges []Edge) (*Graph, error) {
	n := len(ids)
	if n > MaxNodes {
		return nil, fmt.Errorf("dataeng: at most %d observations allowed, got %d", MaxNodes, n)
	}
	if len(y) != n || len(w) != n {
		return nil, fmt.Errorf("dataeng: y and w must each have length %d", n)
	}

	index := make(map[string]int, n)
	for i, id := range ids {
		if id == "" {
			return nil, errors.New("dataeng: node ID must not be empty")
		}
		if _, exists := index[id]; exists {
			return nil, fmt.Errorf("dataeng: duplicate node ID %q", id)
		}
		if y[i] == nil {
			return nil, fmt.Errorf("dataeng: observation y for %q must not be nil", id)
		}
		if w[i] == nil {
			return nil, fmt.Errorf("dataeng: weight w for %q must not be nil", id)
		}
		if w[i].Sign() <= 0 {
			return nil, fmt.Errorf("dataeng: weight w for %q must be strictly positive, got %s", id, w[i].RatString())
		}
		index[id] = i
	}

	g := &Graph{
		ids:   append([]string(nil), ids...),
		index: index,
		adj:   make([][]int, n),
	}

	seenEdgeID := make(map[string]struct{}, len(edges))
	pairIndex := make(map[[2]int]int, len(edges))
	for _, e := range edges {
		if e.EdgeID == "" {
			return nil, errors.New("dataeng: edge ID must not be empty")
		}
		if _, dup := seenEdgeID[e.EdgeID]; dup {
			return nil, fmt.Errorf("dataeng: duplicate edge ID %q", e.EdgeID)
		}
		seenEdgeID[e.EdgeID] = struct{}{}

		u, okU := index[e.From]
		if !okU {
			return nil, fmt.Errorf("dataeng: edge %q references unknown node %q", e.EdgeID, e.From)
		}
		v, okV := index[e.To]
		if !okV {
			return nil, fmt.Errorf("dataeng: edge %q references unknown node %q", e.EdgeID, e.To)
		}
		if u == v {
			return nil, fmt.Errorf("dataeng: edge %q is a self loop on %q", e.EdgeID, e.From)
		}

		key := [2]int{u, v}
		if pos, merged := pairIndex[key]; merged {
			g.edges[pos].sourceIDs = append(g.edges[pos].sourceIDs, e.EdgeID)
			continue
		}
		pairIndex[key] = len(g.edges)
		g.edges = append(g.edges, dedupEdge{
			from:      u,
			to:        v,
			sourceIDs: []string{e.EdgeID},
		})
		g.adj[u] = append(g.adj[u], v)
	}

	if err := g.requireAcyclic(); err != nil {
		return nil, err
	}
	return g, nil
}

// requireAcyclic runs Kahn's algorithm and rejects any directed cycle.
func (g *Graph) requireAcyclic() error {
	n := len(g.ids)
	indeg := make([]int, n)
	for _, e := range g.edges {
		indeg[e.to]++
	}
	queue := make([]int, 0, n)
	for i := 0; i < n; i++ {
		if indeg[i] == 0 {
			queue = append(queue, i)
		}
	}
	visited := 0
	for head := 0; head < len(queue); head++ {
		u := queue[head]
		visited++
		for _, v := range g.adj[u] {
			indeg[v]--
			if indeg[v] == 0 {
				queue = append(queue, v)
			}
		}
	}
	if visited != n {
		return errors.New("dataeng: constraint graph must be acyclic")
	}
	return nil
}

// N returns the number of observation nodes.
func (g *Graph) N() int { return len(g.ids) }

// NodeID returns the immutable identifier of node i.
func (g *Graph) NodeID(i int) string { return g.ids[i] }

// nodeIndex looks up a node, returning false for unknown IDs.
func (g *Graph) nodeIndex(id string) (int, bool) {
	i, ok := g.index[id]
	return i, ok
}

// DedupEdgeCount returns the number of unique (From,To) edges.
func (g *Graph) DedupEdgeCount() int { return len(g.edges) }

// DedupEdge describes one unique edge and the original IDs merged into it.
type DedupEdge struct {
	From      string
	To        string
	SourceIDs []string
}

// DedupEdges returns all unique edges in first-seen pair order. The slices are
// copies, so callers cannot mutate compiled graph state.
func (g *Graph) DedupEdges() []DedupEdge {
	out := make([]DedupEdge, len(g.edges))
	for k, e := range g.edges {
		out[k] = DedupEdge{
			From:      g.ids[e.from],
			To:        g.ids[e.to],
			SourceIDs: append([]string(nil), e.sourceIDs...),
		}
	}
	return out
}
