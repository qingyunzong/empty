package workgroup

import (
	"errors"
	"strings"
	"sync"
)

// CycleError reports that adding a wait edge would close a cycle in
// the wait graph. Path is the evidence: it starts and ends with the
// group that initiated the offending edge, listing every group along
// the cycle in wait order.
type CycleError struct {
	Path []string
}

func (e *CycleError) Error() string {
	return "workgroup: wait edge would create cycle: " + strings.Join(e.Path, " -> ")
}

// Graph is a collection of groups plus the wait edges between them.
// An edge u -> v means u waits for v. The graph is kept acyclic:
// AddWait refuses edges that would close a cycle.
type Graph struct {
	mu     sync.Mutex
	groups map[string]*Group
	edges  map[string]map[string]bool
}

// NewGraph returns an empty wait graph.
func NewGraph() *Graph {
	return &Graph{
		groups: make(map[string]*Group),
		edges:  make(map[string]map[string]bool),
	}
}

// Group returns the group with the given name, creating it on first
// use.
func (t *Graph) Group(name string) *Group {
	t.mu.Lock()
	defer t.mu.Unlock()
	if g, ok := t.groups[name]; ok {
		return g
	}
	g := &Group{name: name, graph: t, done: make(chan struct{})}
	t.groups[name] = g
	return g
}

// AddWait records that group from waits for group to. If the edge
// would create a cycle, AddWait returns a *CycleError whose Path is
// the cycle evidence including the rejected edge, and the graph is
// left unchanged.
func (t *Graph) AddWait(from, to string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.edges[from][to] {
		return nil // duplicate edge is a no-op
	}
	if path := t.reachLocked(to, from); path != nil {
		// path runs to -> ... -> from; prepending from (the new
		// edge from -> to) closes the loop.
		cycle := make([]string, 0, len(path)+1)
		cycle = append(cycle, from)
		cycle = append(cycle, path...)
		return &CycleError{Path: cycle}
	}
	if t.edges[from] == nil {
		t.edges[from] = make(map[string]bool)
	}
	t.edges[from][to] = true
	return nil
}

// reachLocked reports whether start can reach target along existing
// edges, returning the witnessing path (including both endpoints) or
// nil. Breadth-first search keeps the evidence short.
func (t *Graph) reachLocked(start, target string) []string {
	prev := map[string]string{start: ""}
	queue := []string{start}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if cur == target {
			var path []string
			for at := target; ; at = prev[at] {
				path = append(path, at)
				if at == start {
					break
				}
			}
			for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
				path[i], path[j] = path[j], path[i]
			}
			return path
		}
		for next := range t.edges[cur] {
			if _, seen := prev[next]; !seen {
				prev[next] = cur
				queue = append(queue, next)
			}
		}
	}
	return nil
}

// Edges returns a snapshot of every wait edge as [from, to] pairs,
// suitable for independent verification by a Checker.
func (t *Graph) Edges() [][2]string {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out [][2]string
	for from, tos := range t.edges {
		for to := range tos {
			out = append(out, [2]string{from, to})
		}
	}
	return out
}

// WaitOn declares that g waits for other (cycle-checked) and then
// blocks until other has fully closed.
func (g *Group) WaitOn(other *Group) error {
	if g.graph != other.graph {
		return errors.New("workgroup: groups belong to different graphs")
	}
	if err := g.graph.AddWait(g.name, other.name); err != nil {
		return err
	}
	other.Wait()
	return nil
}
