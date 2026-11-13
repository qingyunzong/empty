package dataeng

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// Query describes a lineage traversal. Depth is the maximum number of edges to
// follow; zero returns only the start node and a negative value is unlimited.
// MaxDepth is an alias for Depth and wins when non-zero.
type Query struct {
	Start     NodeID
	Depth     int
	MaxDepth  int
	Direction Direction
	EdgeTypes []EdgeType
	MaxPaths  int // zero means no limit
}

// Path is one acyclic prefix of a lineage traversal. Nodes[0] is the start
// node. Length equals len(Edges).
type Path struct {
	Nodes     []NodeID   `json:"nodes"`
	Edges     []Edge     `json:"edges,omitempty"`
	EdgeTypes []EdgeType `json:"edge_types,omitempty"`
	Length    int        `json:"length"`
}

// Cycle is the first evidence observed for one edge-type-aware cycle. Nodes
// includes the repeated closing node, so Nodes[0] == Nodes[len(Nodes)-1].
type Cycle struct {
	Nodes     []NodeID   `json:"nodes"`
	Edges     []Edge     `json:"edges"`
	EdgeTypes []EdgeType `json:"edge_types"`
	Depth     int        `json:"depth"`
	Length    int        `json:"length"`
}

// Result is the complete result of one query against one snapshot.
type Result struct {
	Version   uint64   `json:"version"`
	Start     NodeID   `json:"start"`
	Nodes     []Node   `json:"nodes"`
	Edges     []Edge   `json:"edges,omitempty"`
	Paths     []Path   `json:"paths"`
	Cycles    []Cycle  `json:"cycles,omitempty"`
	Frontier  []NodeID `json:"frontier,omitempty"`
	Truncated bool     `json:"truncated,omitempty"`
}

// UpstreamResult, QueryResult, and LineageResult are aliases for Result.
type UpstreamResult = Result
type QueryResult = Result
type LineageResult = Result

// HasCycles reports whether the traversal found at least one cycle.
func (r *Result) HasCycles() bool {
	return r != nil && len(r.Cycles) > 0
}

// NodeIDs returns the IDs of all reachable nodes including the start node.
func (r *Result) NodeIDs() []NodeID {
	if r == nil {
		return nil
	}
	out := make([]NodeID, len(r.Nodes))
	for i, n := range r.Nodes {
		out[i] = n.ID
	}
	return out
}

// Query traverses the current snapshot.
func (c *Catalog) Query(ctx context.Context, q Query) (*Result, error) {
	s := c.Snapshot()
	if s == nil {
		return nil, fmt.Errorf("%w: nil snapshot", ErrInvalidQuery)
	}
	return s.Query(ctx, q)
}

// QueryAt traverses a retained snapshot, which is useful for reproducible
// analysis or for comparing two versions.
func (c *Catalog) QueryAt(ctx context.Context, version uint64, q Query) (*Result, error) {
	s, err := c.SnapshotAt(version)
	if err != nil {
		return nil, err
	}
	return s.Query(ctx, q)
}

// Upstream queries upstream paths within depth from the current snapshot.
func (c *Catalog) Upstream(start NodeID, depth int) (*Result, error) {
	return c.Query(context.Background(), Query{Start: start, Depth: depth, Direction: Upstream})
}

// QueryUpstream is an alias for Upstream with optional edge-type filtering.
func (c *Catalog) QueryUpstream(start NodeID, depth int, edgeTypes ...EdgeType) (*Result, error) {
	return c.Query(context.Background(), Query{
		Start:     start,
		Depth:     depth,
		Direction: Upstream,
		EdgeTypes: edgeTypes,
	})
}

// Downstream queries downstream paths within depth from the current snapshot.
func (c *Catalog) Downstream(start NodeID, depth int) (*Result, error) {
	return c.Query(context.Background(), Query{Start: start, Depth: depth, Direction: Downstream})
}

// QueryDownstream is an alias for Downstream with optional edge-type filtering.
func (c *Catalog) QueryDownstream(start NodeID, depth int, edgeTypes ...EdgeType) (*Result, error) {
	return c.Query(context.Background(), Query{
		Start:     start,
		Depth:     depth,
		Direction: Downstream,
		EdgeTypes: edgeTypes,
	})
}

// Query traverses this immutable snapshot.
func (s *Snapshot) Query(ctx context.Context, q Query) (*Result, error) {
	if s == nil {
		return nil, fmt.Errorf("%w: nil snapshot", ErrInvalidQuery)
	}
	start := NodeID(strings.TrimSpace(string(q.Start)))
	if start == "" {
		return nil, fmt.Errorf("%w: empty start node", ErrInvalidQuery)
	}
	if !s.HasNode(start) {
		return nil, fmt.Errorf("%w: %s", ErrNodeNotFound, start)
	}
	if q.Direction != Upstream && q.Direction != Downstream {
		return nil, fmt.Errorf("%w: unknown direction %d", ErrInvalidQuery, q.Direction)
	}
	if q.MaxPaths < 0 {
		return nil, fmt.Errorf("%w: negative max paths", ErrInvalidQuery)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	maxDepth := q.Depth
	if q.MaxDepth != 0 {
		maxDepth = q.MaxDepth
	}

	filter := make(map[EdgeType]struct{}, len(q.EdgeTypes))
	for _, t := range q.EdgeTypes {
		if t != "" {
			filter[t] = struct{}{}
		}
	}

	t := &traversal{
		ctx:         ctx,
		snapshot:    s,
		start:       start,
		direction:   q.Direction,
		maxDepth:    maxDepth,
		maxPaths:    q.MaxPaths,
		filter:      filter,
		stateIndex:  map[stateKey]int{{node: start}: 0},
		nodeSet:     map[NodeID]struct{}{start: {}},
		edgeSet:     make(map[EdgeID]Edge),
		cycleSeen:   make(map[string]struct{}),
		frontierSet: make(map[NodeID]struct{}),
		result: &Result{
			Version: s.version,
			Start:   start,
		},
	}
	t.pathNodes = []NodeID{start}
	t.pathStates = []stateKey{{node: start}}

	if err := t.walk(start, 0); err != nil {
		return nil, err
	}

	t.result.Nodes = t.sortedNodes()
	t.result.Edges = t.sortedEdges()
	t.result.Paths = t.paths
	t.result.Cycles = t.cycles
	t.result.Frontier = t.sortedFrontier()
	return t.result, nil
}

// Upstream queries this snapshot for upstream paths.
func (s *Snapshot) Upstream(start NodeID, depth int) (*Result, error) {
	return s.Query(context.Background(), Query{Start: start, Depth: depth, Direction: Upstream})
}

// Downstream queries this snapshot for downstream paths.
func (s *Snapshot) Downstream(start NodeID, depth int) (*Result, error) {
	return s.Query(context.Background(), Query{Start: start, Depth: depth, Direction: Downstream})
}

type stateKey struct {
	node     NodeID
	edgeType EdgeType
}

type traversal struct {
	ctx       context.Context
	snapshot  *Snapshot
	start     NodeID
	direction Direction
	maxDepth  int
	maxPaths  int
	filter    map[EdgeType]struct{}

	pathNodes  []NodeID
	pathEdges  []Edge
	pathStates []stateKey
	stateIndex map[stateKey]int

	nodeSet     map[NodeID]struct{}
	edgeSet     map[EdgeID]Edge
	cycleSeen   map[string]struct{}
	frontierSet map[NodeID]struct{}
	paths       []Path
	cycles      []Cycle
	result      *Result
}

func (t *traversal) walk(current NodeID, depth int) error {
	if err := t.ctx.Err(); err != nil {
		return err
	}
	if t.maxPaths > 0 && len(t.paths) >= t.maxPaths {
		t.result.Truncated = true
		return nil
	}
	t.paths = append(t.paths, t.copyCurrentPath())

	neighbors := t.neighbors(current)
	if len(neighbors) == 0 {
		return nil
	}
	if t.maxDepth >= 0 && depth >= t.maxDepth {
		t.result.Truncated = true
		t.frontierSet[current] = struct{}{}
		return nil
	}

	for _, e := range neighbors {
		if err := t.ctx.Err(); err != nil {
			return err
		}
		next := e.To
		if t.direction == Upstream {
			next = e.From
		}
		t.edgeSet[e.ID] = e
		if _, ok := t.snapshot.nodes[next]; !ok {
			// Edges should always have endpoints, but skipping an orphan keeps
			// a hand-built snapshot from causing a panic.
			continue
		}
		if next == t.start {
			// A walk that returns to its root is a closed cycle regardless of
			// the incoming relationship type. The root has no incoming edge
			// type, so treating it as a wildcard is necessary to detect cycles
			// of length <= the requested depth.
			t.recordCycle(0, next, e, depth+1)
			continue
		}

		key := stateKey{node: next, edgeType: e.Type}
		if at, ok := t.stateIndex[key]; ok {
			t.recordCycle(at, next, e, depth+1)
			continue
		}

		t.pathNodes = append(t.pathNodes, next)
		t.pathEdges = append(t.pathEdges, e)
		t.pathStates = append(t.pathStates, key)
		t.stateIndex[key] = len(t.pathNodes) - 1
		t.nodeSet[next] = struct{}{}

		err := t.walk(next, depth+1)

		delete(t.stateIndex, key)
		t.pathNodes = t.pathNodes[:len(t.pathNodes)-1]
		t.pathEdges = t.pathEdges[:len(t.pathEdges)-1]
		t.pathStates = t.pathStates[:len(t.pathStates)-1]
		if err != nil {
			return err
		}
	}
	return nil
}

func (t *traversal) neighbors(id NodeID) []Edge {
	raw := t.snapshot.incomingRaw(id)
	if t.direction == Downstream {
		raw = t.snapshot.outgoingRaw(id)
	}
	if len(t.filter) == 0 {
		return raw
	}
	out := make([]Edge, 0, len(raw))
	for _, e := range raw {
		if _, ok := t.filter[e.Type]; ok {
			out = append(out, e)
		}
	}
	return out
}

func (t *traversal) copyCurrentPath() Path {
	p := Path{
		Nodes:     append([]NodeID(nil), t.pathNodes...),
		Edges:     make([]Edge, 0, len(t.pathEdges)),
		EdgeTypes: make([]EdgeType, 0, len(t.pathEdges)),
		Length:    len(t.pathEdges),
	}
	for _, e := range t.pathEdges {
		p.Edges = append(p.Edges, cloneEdge(e))
		p.EdgeTypes = append(p.EdgeTypes, e.Type)
	}
	return p
}

func (t *traversal) recordCycle(at int, closingNode NodeID, closing Edge, detectDepth int) {
	nodes := make([]NodeID, 0, len(t.pathNodes)-at+1)
	nodes = append(nodes, t.pathNodes[at:]...)
	nodes = append(nodes, closingNode)

	edges := make([]Edge, 0, len(t.pathEdges)-at+1)
	for _, e := range t.pathEdges[at:] {
		edges = append(edges, cloneEdge(e))
	}
	edges = append(edges, cloneEdge(closing))

	sig := canonicalCycleSignature(nodes, edges)
	if _, ok := t.cycleSeen[sig]; ok {
		return
	}
	t.cycleSeen[sig] = struct{}{}

	types := make([]EdgeType, 0, len(edges))
	for _, e := range edges {
		types = append(types, e.Type)
		t.edgeSet[e.ID] = e
	}
	t.cycles = append(t.cycles, Cycle{
		Nodes:     nodes,
		Edges:     edges,
		EdgeTypes: types,
		Depth:     detectDepth,
		Length:    len(edges),
	})
}

// canonicalCycleSignature makes rotated discoveries of the same cycle compare
// equal, so only the first piece of evidence is retained.
func canonicalCycleSignature(nodes []NodeID, edges []Edge) string {
	n := len(edges)
	if n == 0 {
		return ""
	}
	tokens := make([]string, n)
	for i := 0; i < n; i++ {
		next := nodes[i+1]
		tokens[i] = string(next) + "\x1f" + string(edges[i].Type)
	}
	best := ""
	for shift := 0; shift < n; shift++ {
		var b strings.Builder
		for i := 0; i < n; i++ {
			b.WriteString(tokens[(shift+i)%n])
			b.WriteByte(0)
		}
		s := b.String()
		if best == "" || s < best {
			best = s
		}
	}
	return best
}

func (t *traversal) sortedNodes() []Node {
	ids := make([]NodeID, 0, len(t.nodeSet))
	for id := range t.nodeSet {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	out := make([]Node, 0, len(ids))
	for _, id := range ids {
		out = append(out, cloneNode(t.snapshot.nodes[id]))
	}
	return out
}

func (t *traversal) sortedEdges() []Edge {
	ids := make([]EdgeID, 0, len(t.edgeSet))
	for id := range t.edgeSet {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	out := make([]Edge, 0, len(ids))
	for _, id := range ids {
		out = append(out, cloneEdge(t.edgeSet[id]))
	}
	return out
}

func (t *traversal) sortedFrontier() []NodeID {
	ids := make([]NodeID, 0, len(t.frontierSet))
	for id := range t.frontierSet {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}
