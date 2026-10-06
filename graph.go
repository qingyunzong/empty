// Package depimpact analyzes file-level dependency graphs together with a
// change set and reports, for every test, the shortest dependency path
// through which a change affects it.
//
// Direction convention: an edge From -> To means "From depends on To".
// Impact therefore propagates along reverse edges, from a changed file
// toward the files that (transitively) depend on it.
//
// Deleted nodes keep their old-graph influence: the analysis runs on the
// merge (union) of the old and the new graph, so edges that only existed
// before the change still carry impact.
package depimpact

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// Edge describes a single dependency: From depends on To.
type Edge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// Graph is a file-level dependency graph.
type Graph struct {
	nodes map[string]struct{}
	adj   map[string]map[string]struct{} // From -> set(To): dependencies
	rev   map[string]map[string]struct{} // To   -> set(From): dependents
}

// NewGraph returns an empty graph.
func NewGraph() *Graph {
	return &Graph{
		nodes: make(map[string]struct{}),
		adj:   make(map[string]map[string]struct{}),
		rev:   make(map[string]map[string]struct{}),
	}
}

// AddNode adds an isolated node.
func (g *Graph) AddNode(id string) {
	g.nodes[id] = struct{}{}
}

// AddEdge records that from depends on to, adding endpoints implicitly.
func (g *Graph) AddEdge(from, to string) {
	g.AddNode(from)
	g.AddNode(to)
	if g.adj[from] == nil {
		g.adj[from] = make(map[string]struct{})
	}
	g.adj[from][to] = struct{}{}
	if g.rev[to] == nil {
		g.rev[to] = make(map[string]struct{})
	}
	g.rev[to][from] = struct{}{}
}

// Has reports whether id is a node of the graph.
func (g *Graph) Has(id string) bool {
	_, ok := g.nodes[id]
	return ok
}

// Nodes returns all node IDs in ascending order.
func (g *Graph) Nodes() []string {
	out := make([]string, 0, len(g.nodes))
	for id := range g.nodes {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Dependencies returns the sorted IDs that id directly depends on.
func (g *Graph) Dependencies(id string) []string {
	return sortedKeys(g.adj[id])
}

// Dependents returns the sorted IDs that directly depend on id.
// Impact flows along these edges.
func (g *Graph) Dependents(id string) []string {
	return sortedKeys(g.rev[id])
}

func sortedKeys(set map[string]struct{}) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Merge returns the union of the given graphs: every node and every edge
// of every input is present in the result. This is what keeps deleted
// nodes influential: their old-graph edges survive in the merged graph.
func Merge(graphs ...*Graph) *Graph {
	m := NewGraph()
	for _, g := range graphs {
		if g == nil {
			continue
		}
		for id := range g.nodes {
			m.AddNode(id)
		}
		for from, tos := range g.adj {
			for to := range tos {
				m.AddEdge(from, to)
			}
		}
	}
	return m
}

// graphJSON is the on-disk representation of a Graph.
type graphJSON struct {
	Nodes []string `json:"nodes"`
	Edges []Edge   `json:"edges"`
}

// ParseGraph builds a Graph from its JSON representation.
func ParseGraph(data []byte) (*Graph, error) {
	var gj graphJSON
	if err := json.Unmarshal(data, &gj); err != nil {
		return nil, fmt.Errorf("depimpact: parsing graph: %w", err)
	}
	g := NewGraph()
	for _, n := range gj.Nodes {
		if n == "" {
			return nil, fmt.Errorf("depimpact: empty node id")
		}
		g.AddNode(n)
	}
	for _, e := range gj.Edges {
		if e.From == "" || e.To == "" {
			return nil, fmt.Errorf("depimpact: edge with empty endpoint: %+v", e)
		}
		g.AddEdge(e.From, e.To)
	}
	return g, nil
}

// LoadGraph reads and parses a graph JSON file.
func LoadGraph(path string) (*Graph, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("depimpact: reading graph %q: %w", path, err)
	}
	return ParseGraph(data)
}
