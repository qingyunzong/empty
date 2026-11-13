package dataeng

import (
	"fmt"
	"sort"
	"strings"
)

// PathEdge is one labeled step in a conflict path.
type PathEdge struct {
	From string
	To   string
	Kind LinkKind
}

// ConflictPath is a minimum-length certificate that two entities cannot be
// placed in the same cluster. All edges except exactly one must be must-link or
// accepted-merge edges; the remaining edge is a cannot-link.
type ConflictPath struct {
	Nodes []string
	Edges []PathEdge
}

// Length returns the number of edges in the path.
func (p ConflictPath) Length() int { return len(p.Edges) }

// String renders the path as "a -must-> b -cannot-> c".
func (p ConflictPath) String() string {
	if len(p.Nodes) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(p.Nodes[0])
	for _, e := range p.Edges {
		b.WriteString(" -")
		b.WriteString(e.Kind.String())
		b.WriteString("-> ")
		b.WriteString(e.To)
	}
	return b.String()
}

// Validate checks that the path is structurally a conflict certificate.
func (p ConflictPath) Validate() error {
	if len(p.Nodes) < 2 {
		return fmt.Errorf("dataeng: conflict path needs at least two nodes")
	}
	if len(p.Edges) != len(p.Nodes)-1 {
		return fmt.Errorf("dataeng: conflict path has %d nodes and %d edges", len(p.Nodes), len(p.Edges))
	}
	cannot := 0
	for i, e := range p.Edges {
		if e.From != p.Nodes[i] || e.To != p.Nodes[i+1] {
			return fmt.Errorf("dataeng: edge %d does not match path nodes", i)
		}
		switch e.Kind {
		case LinkCannot:
			cannot++
		case LinkMust, LinkMerge:
		default:
			return fmt.Errorf("dataeng: edge %d has unknown kind %d", i, e.Kind)
		}
	}
	if cannot != 1 {
		return fmt.Errorf("dataeng: conflict path must contain exactly one cannot-link, got %d", cannot)
	}
	return nil
}

// minimalConflictPath finds the shortest path from u to v whose only
// cannot-link edge crosses the two components. Ties are broken by the
// lexicographic order of the node sequence, making the result deterministic.
func (g *Graph) minimalConflictPath(u, v string) ConflictPath {
	ru, rv := g.find(u), g.find(v)
	_, parentU := g.bfs(u)
	distV, _ := g.bfs(v)

	var best ConflictPath
	found := false

	for _, ce := range g.cannot {
		var orientations [][2]string
		if g.find(ce.Left) == ru && g.find(ce.Right) == rv {
			orientations = append(orientations, [2]string{ce.Left, ce.Right})
		}
		if g.find(ce.Right) == ru && g.find(ce.Left) == rv {
			orientations = append(orientations, [2]string{ce.Right, ce.Left})
		}

		for _, o := range orientations {
			prefix, okPrefix := g.lexShortestPath(u, o[0], parentU)
			suffix, okSuffix := g.lexPathToRoot(o[1], v, distV)
			if !okPrefix || !okSuffix {
				continue
			}

			path := ConflictPath{
				Nodes: make([]string, 0, len(prefix)+len(suffix)-1),
				Edges: make([]PathEdge, 0, len(prefix)+len(suffix)-1),
			}
			path.Nodes = append(path.Nodes, prefix...)
			path.Nodes = append(path.Nodes, suffix...)
			for i := 0; i+1 < len(prefix); i++ {
				path.Edges = append(path.Edges, PathEdge{
					From: prefix[i], To: prefix[i+1], Kind: g.linkKind(prefix[i], prefix[i+1]),
				})
			}
			path.Edges = append(path.Edges, PathEdge{
				From: o[0], To: o[1], Kind: LinkCannot,
			})
			for i := 0; i+1 < len(suffix); i++ {
				path.Edges = append(path.Edges, PathEdge{
					From: suffix[i], To: suffix[i+1], Kind: g.linkKind(suffix[i], suffix[i+1]),
				})
			}

			if !found || conflictPathLess(path, best) {
				best = path
				found = true
			}
		}
	}

	if !found {
		// The enemy invariant guarantees at least one crossing cannot-link.
		// Keep a structurally valid fallback rather than returning an empty path.
		return ConflictPath{
			Nodes: []string{u, v},
			Edges: []PathEdge{{From: u, To: v, Kind: LinkCannot}},
		}
	}
	return best
}

func (g *Graph) bfs(from string) (map[string]int, map[string]string) {
	dist := map[string]int{from: 0}
	parent := make(map[string]string)
	queue := []string{from}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, next := range g.sortedNeighbors(cur) {
			if _, seen := dist[next]; seen {
				continue
			}
			dist[next] = dist[cur] + 1
			parent[next] = cur
			queue = append(queue, next)
		}
	}
	return dist, parent
}

// lexShortestPath reconstructs the lexicographically smallest shortest path
// from "from" to "to" using the BFS parent map rooted at "from". BFS discovers
// nodes in lexicographic path order when adjacency is sorted.
func (g *Graph) lexShortestPath(from, to string, parent map[string]string) ([]string, bool) {
	if from == to {
		return []string{from}, true
	}
	if _, ok := parent[to]; !ok {
		return nil, false
	}

	reversed := []string{to}
	cur := to
	for cur != from {
		prev, ok := parent[cur]
		if !ok {
			return nil, false
		}
		reversed = append(reversed, prev)
		cur = prev
	}
	path := make([]string, len(reversed))
	for i := range reversed {
		path[len(reversed)-1-i] = reversed[i]
	}
	return path, true
}

// lexPathToRoot reconstructs the lexicographically smallest shortest path from
// "from" to "root" using the BFS distance map rooted at "root".
func (g *Graph) lexPathToRoot(from, root string, dist map[string]int) ([]string, bool) {
	target, ok := dist[from]
	if !ok {
		return nil, false
	}
	if from == root {
		return []string{from}, true
	}

	path := make([]string, 0, target+1)
	cur := from
	path = append(path, cur)
	for cur != root {
		next := ""
		for _, neighbor := range g.sortedNeighbors(cur) {
			if d, ok := dist[neighbor]; ok && d == dist[cur]-1 {
				next = neighbor
				break
			}
		}
		if next == "" {
			return nil, false
		}
		path = append(path, next)
		cur = next
	}
	return path, true
}

func (g *Graph) sortedNeighbors(id string) []string {
	neighbors := make([]string, 0, len(g.mustAdj[id]))
	for next := range g.mustAdj[id] {
		neighbors = append(neighbors, next)
	}
	sort.Strings(neighbors)
	return neighbors
}

func (g *Graph) linkKind(a, b string) LinkKind {
	if neighbors := g.mustAdj[a]; neighbors != nil {
		if kind, ok := neighbors[b]; ok {
			return kind
		}
	}
	return LinkMust
}

func conflictPathLess(a, b ConflictPath) bool {
	if len(a.Edges) != len(b.Edges) {
		return len(a.Edges) < len(b.Edges)
	}
	for i := range a.Nodes {
		if a.Nodes[i] != b.Nodes[i] {
			return a.Nodes[i] < b.Nodes[i]
		}
	}
	return false
}
