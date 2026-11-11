package q159

import (
	"fmt"
	"sort"
	"sync"
)

// snapshot is an immutable, versioned view of the graph with its own path
// cache. Old snapshots remain reachable by batches admitted before an
// update, and their caches can never be written by a newer version.
type snapshot struct {
	version uint64
	adj     map[SchemaID][]Edge
	all     map[EdgeID]Edge

	cacheMu sync.RWMutex
	cache   map[SchemaID]map[SchemaID][]Edge
}

func buildSnapshot(edges []Edge, version uint64) (*snapshot, error) {
	snap := &snapshot{
		version: version,
		adj:     make(map[SchemaID][]Edge),
		all:     make(map[EdgeID]Edge, len(edges)),
		cache:   make(map[SchemaID]map[SchemaID][]Edge),
	}
	vertices := make(map[SchemaID]struct{}, len(edges)*2)
	for _, edge := range edges {
		if edge.ID == "" || edge.From == "" || edge.To == "" || edge.Apply == nil {
			return nil, fmt.Errorf("%w: edge must define ID, From, To and Apply", ErrInvalidEdge)
		}
		if edge.Cost == 0 {
			return nil, fmt.Errorf("%w: edge %q cost must be a positive integer", ErrInvalidEdge, edge.ID)
		}
		if _, dup := snap.all[edge.ID]; dup {
			return nil, fmt.Errorf("%w: %q", ErrDuplicateEdge, edge.ID)
		}
		snap.all[edge.ID] = edge
		snap.adj[edge.From] = append(snap.adj[edge.From], edge)
		vertices[edge.From] = struct{}{}
		vertices[edge.To] = struct{}{}
	}
	for from := range snap.adj {
		sort.Slice(snap.adj[from], func(i, j int) bool {
			return snap.adj[from][i].ID < snap.adj[from][j].ID
		})
	}
	if hasCycle(snap.adj, vertices) {
		return nil, ErrCycle
	}
	return snap, nil
}

// hasCycle runs an iterative DFS coloring pass over all vertices.
func hasCycle(adj map[SchemaID][]Edge, vertices map[SchemaID]struct{}) bool {
	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make(map[SchemaID]int, len(vertices))
	order := make([]SchemaID, 0, len(vertices))
	for v := range vertices {
		order = append(order, v)
	}
	sort.Slice(order, func(i, j int) bool { return order[i] < order[j] })

	type frame struct {
		v    SchemaID
		next int
	}
	for _, start := range order {
		if color[start] != white {
			continue
		}
		stack := []frame{{v: start}}
		color[start] = gray
		for len(stack) > 0 {
			top := &stack[len(stack)-1]
			neighbors := adj[top.v]
			if top.next >= len(neighbors) {
				color[top.v] = black
				stack = stack[:len(stack)-1]
				continue
			}
			nextV := neighbors[top.next].To
			top.next++
			switch color[nextV] {
			case gray:
				return true
			case white:
				color[nextV] = gray
				stack = append(stack, frame{v: nextV})
			}
		}
	}
	return false
}
