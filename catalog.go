package dataeng

import (
	"fmt"
	"maps"
	"sort"
	"sync"
	"sync/atomic"
)

// Catalog is a versioned, concurrency-safe lineage graph.
//
// Writers publish a new immutable Snapshot for every successful mutation.
// Readers load the current snapshot once and traverse it without locking, so a
// query always observes exactly one version even while updates are in flight.
type Catalog struct {
	mu           sync.Mutex
	current      atomic.Pointer[Snapshot]
	history      map[uint64]*Snapshot
	historyLimit int // < 0 keeps every retained version
}

// Graph is an alias for Catalog.
type Graph = Catalog

// DataCatalog is an alias for Catalog.
type DataCatalog = Catalog

// CatalogOption configures a Catalog.
type CatalogOption func(*Catalog)

// WithHistoryLimit controls how many snapshots are retained. Zero keeps only
// the current snapshot; a negative value keeps all versions. The default is -1.
func WithHistoryLimit(n int) CatalogOption {
	return func(c *Catalog) {
		c.historyLimit = n
	}
}

// WithoutVersionHistory retains only the current snapshot.
func WithoutVersionHistory() CatalogOption {
	return WithHistoryLimit(0)
}

// NewCatalog creates an empty catalog at version zero.
func NewCatalog(opts ...CatalogOption) *Catalog {
	c := &Catalog{
		history:      make(map[uint64]*Snapshot),
		historyLimit: -1,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(c)
		}
	}
	s := buildSnapshot(0, map[NodeID]Node{}, map[EdgeID]Edge{})
	c.current.Store(s)
	c.history[0] = s
	return c
}

// New, NewGraph, and NewDataCatalog are aliases for NewCatalog.
func New(opts ...CatalogOption) *Catalog            { return NewCatalog(opts...) }
func NewGraph(opts ...CatalogOption) *Catalog       { return NewCatalog(opts...) }
func NewDataCatalog(opts ...CatalogOption) *Catalog { return NewCatalog(opts...) }

// Version returns the current snapshot version.
func (c *Catalog) Version() uint64 {
	if c == nil {
		return 0
	}
	s := c.current.Load()
	if s == nil {
		return 0
	}
	return s.version
}

// LatestVersion is an alias for Version.
func (c *Catalog) LatestVersion() uint64 { return c.Version() }

// Snapshot returns the current immutable snapshot.
func (c *Catalog) Snapshot() *Snapshot {
	if c == nil {
		return nil
	}
	return c.current.Load()
}

// CurrentSnapshot is an alias for Snapshot.
func (c *Catalog) CurrentSnapshot() *Snapshot { return c.Snapshot() }

// SnapshotAt returns a retained snapshot. The current version is always
// available; older versions are available while they remain in the configured
// history window.
func (c *Catalog) SnapshotAt(version uint64) (*Snapshot, error) {
	if c == nil {
		return nil, fmt.Errorf("%w: version %d", ErrVersionAbsent, version)
	}
	cur := c.current.Load()
	if cur != nil && cur.version == version {
		return cur, nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if s, ok := c.history[version]; ok {
		return s, nil
	}
	return nil, fmt.Errorf("%w: version %d", ErrVersionAbsent, version)
}

// Versions returns the retained versions in ascending order.
func (c *Catalog) Versions() []uint64 {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]uint64, 0, len(c.history))
	for v := range c.history {
		out = append(out, v)
	}
	if cur := c.current.Load(); cur != nil {
		found := false
		for _, v := range out {
			if v == cur.version {
				found = true
				break
			}
		}
		if !found {
			out = append(out, cur.version)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// HasNode reports whether id exists in the current snapshot.
func (c *Catalog) HasNode(id NodeID) bool {
	s := c.Snapshot()
	return s != nil && s.HasNode(id)
}

// Node returns a copy of a node from the current snapshot.
func (c *Catalog) Node(id NodeID) (Node, bool) {
	s := c.Snapshot()
	if s == nil {
		return Node{}, false
	}
	return s.Node(id)
}

// GetNode is an alias for Node.
func (c *Catalog) GetNode(id NodeID) (Node, bool) { return c.Node(id) }

// Nodes returns all nodes from the current snapshot in ID order.
func (c *Catalog) Nodes() []Node {
	s := c.Snapshot()
	if s == nil {
		return nil
	}
	return s.Nodes()
}

// NodeCount returns the number of nodes in the current snapshot.
func (c *Catalog) NodeCount() int {
	s := c.Snapshot()
	if s == nil {
		return 0
	}
	return s.NodeCount()
}

// Edges returns all edges from the current snapshot in ID order.
func (c *Catalog) Edges() []Edge {
	s := c.Snapshot()
	if s == nil {
		return nil
	}
	return s.Edges()
}

// EdgeCount returns the number of edges in the current snapshot.
func (c *Catalog) EdgeCount() int {
	s := c.Snapshot()
	if s == nil {
		return 0
	}
	return s.EdgeCount()
}

// Edge returns a copy of an edge from the current snapshot.
func (c *Catalog) Edge(id EdgeID) (Edge, bool) {
	s := c.Snapshot()
	if s == nil {
		return Edge{}, false
	}
	return s.Edge(id)
}

// GetEdge is an alias for Edge.
func (c *Catalog) GetEdge(id EdgeID) (Edge, bool) { return c.Edge(id) }

// HasEdge reports whether id exists in the current snapshot.
func (c *Catalog) HasEdge(id EdgeID) bool {
	s := c.Snapshot()
	return s != nil && s.HasEdge(id)
}

// Outgoing returns downstream edges from id.
func (c *Catalog) Outgoing(id NodeID) []Edge {
	s := c.Snapshot()
	if s == nil {
		return nil
	}
	return s.Outgoing(id)
}

// Incoming returns upstream edges into id.
func (c *Catalog) Incoming(id NodeID) []Edge {
	s := c.Snapshot()
	if s == nil {
		return nil
	}
	return s.Incoming(id)
}

// FindEdges returns edges from the current snapshot matching non-empty filters.
func (c *Catalog) FindEdges(from, to NodeID, typ EdgeType) []Edge {
	s := c.Snapshot()
	if s == nil {
		return nil
	}
	return s.FindEdges(from, to, typ)
}

// AddNode inserts or replaces a node. Replacing a node does not change its
// incident edges. A no-op update does not create a new version.
func (c *Catalog) AddNode(n Node) error {
	return c.AddNodes(n)
}

// UpsertNode is an alias for AddNode.
func (c *Catalog) UpsertNode(n Node) error { return c.AddNode(n) }

// PutNode is an alias for AddNode.
func (c *Catalog) PutNode(n Node) error { return c.AddNode(n) }

// AddNodes atomically inserts or replaces several nodes in one new version.
func (c *Catalog) AddNodes(nodes ...Node) error {
	if c == nil {
		return fmt.Errorf("%w: nil catalog", ErrInvalidNode)
	}
	normalized := make([]Node, 0, len(nodes))
	for i, n := range nodes {
		nn, err := n.normalized()
		if err != nil {
			return fmt.Errorf("node %d: %w", i, err)
		}
		normalized = append(normalized, nn)
	}
	if len(normalized) == 0 {
		return nil
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	cur := c.current.Load()
	next := maps.Clone(cur.nodes)
	changed := false
	for _, n := range normalized {
		if old, ok := next[n.ID]; ok && nodesEqual(old, n) {
			continue
		}
		next[n.ID] = n
		changed = true
	}
	if !changed {
		return nil
	}
	c.publishLocked(next, cur.edges)
	return nil
}

// RemoveNode deletes a node and every edge incident to it. It reports whether
// the node existed.
func (c *Catalog) RemoveNode(id NodeID) bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	cur := c.current.Load()
	if _, ok := cur.nodes[id]; !ok {
		return false
	}
	nextNodes := maps.Clone(cur.nodes)
	delete(nextNodes, id)

	nextEdges := make(map[EdgeID]Edge, len(cur.edges))
	for eid, e := range cur.edges {
		if e.From == id || e.To == id {
			continue
		}
		nextEdges[eid] = e
	}
	c.publishLocked(nextNodes, nextEdges)
	return true
}

// DeleteNode is an alias for RemoveNode.
func (c *Catalog) DeleteNode(id NodeID) bool { return c.RemoveNode(id) }

// AddEdge inserts or replaces an edge. Endpoints missing from the catalog are
// materialized as unknown-type placeholder nodes so a catalog can be loaded
// edge-first. A no-op update does not create a new version.
func (c *Catalog) AddEdge(e Edge) error {
	return c.AddEdges(e)
}

// UpsertEdge is an alias for AddEdge.
func (c *Catalog) UpsertEdge(e Edge) error { return c.AddEdge(e) }

// PutEdge is an alias for AddEdge.
func (c *Catalog) PutEdge(e Edge) error { return c.AddEdge(e) }

// Connect adds a flow-oriented edge from an upstream node to a downstream node.
func (c *Catalog) Connect(upstream, downstream NodeID, typ EdgeType) error {
	return c.AddEdge(Edge{From: upstream, To: downstream, Type: typ})
}

// AddDependency adds an edge in dependency notation: downstream depends on
// upstream. It is the same edge as Connect(upstream, downstream, typ).
func (c *Catalog) AddDependency(downstream, upstream NodeID, typ EdgeType) error {
	return c.Connect(upstream, downstream, typ)
}

// AddEdges atomically inserts or replaces several edges in one new version.
func (c *Catalog) AddEdges(edges ...Edge) error {
	if c == nil {
		return fmt.Errorf("%w: nil catalog", ErrInvalidEdge)
	}
	normalized := make([]Edge, 0, len(edges))
	for i, e := range edges {
		ne, err := e.normalized()
		if err != nil {
			return fmt.Errorf("edge %d: %w", i, err)
		}
		normalized = append(normalized, ne)
	}
	if len(normalized) == 0 {
		return nil
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	cur := c.current.Load()
	nextNodes := maps.Clone(cur.nodes)
	nextEdges := maps.Clone(cur.edges)
	changed := false
	for _, e := range normalized {
		if old, ok := nextEdges[e.ID]; ok && edgesEqual(old, e) {
			continue
		}
		ensureEndpoints(nextNodes, e)
		nextEdges[e.ID] = e
		changed = true
	}
	if !changed {
		return nil
	}
	c.publishLocked(nextNodes, nextEdges)
	return nil
}

// RemoveEdge deletes an edge by ID and reports whether it existed.
func (c *Catalog) RemoveEdge(id EdgeID) bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	cur := c.current.Load()
	if _, ok := cur.edges[id]; !ok {
		return false
	}
	next := maps.Clone(cur.edges)
	delete(next, id)
	c.publishLocked(cur.nodes, next)
	return true
}

// RemoveEdgeBetween deletes all edges matching the non-empty filters and
// returns the number removed.
func (c *Catalog) RemoveEdgeBetween(from, to NodeID, typ EdgeType) int {
	if c == nil {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	cur := c.current.Load()
	next := maps.Clone(cur.edges)
	removed := 0
	for id, e := range next {
		if from != "" && e.From != from {
			continue
		}
		if to != "" && e.To != to {
			continue
		}
		if typ != "" && e.Type != typ {
			continue
		}
		delete(next, id)
		removed++
	}
	if removed > 0 {
		c.publishLocked(cur.nodes, next)
	}
	return removed
}

// RemoveEdges deletes several edges atomically.
func (c *Catalog) RemoveEdges(edges ...Edge) error {
	if c == nil {
		return nil
	}
	ids := make([]EdgeID, 0, len(edges))
	for i, e := range edges {
		id, err := edgeIDForRemoval(e)
		if err != nil {
			return fmt.Errorf("edge %d: %w", i, err)
		}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	cur := c.current.Load()
	next := maps.Clone(cur.edges)
	changed := false
	for _, id := range ids {
		if _, ok := next[id]; ok {
			delete(next, id)
			changed = true
		}
	}
	if changed {
		c.publishLocked(cur.nodes, next)
	}
	return nil
}

// EdgeOp identifies an operation in an EdgeUpdate batch.
type EdgeOp uint8

const (
	EdgeOpAdd EdgeOp = iota
	EdgeOpRemove
)

const (
	AddEdgeOp    = EdgeOpAdd
	RemoveEdgeOp = EdgeOpRemove
)

// EdgeUpdate is one operation in an atomic edge batch.  The zero Op adds the
// edge, which makes the common case a simple EdgeUpdate{Edge: e}.
type EdgeUpdate struct {
	Op   EdgeOp
	Edge Edge
}

// ApplyEdgeUpdates applies all edge additions and removals in one snapshot.
// Either every update is visible to subsequent queries or none is. The return
// value is the snapshot version that became current.
func (c *Catalog) ApplyEdgeUpdates(updates ...EdgeUpdate) (uint64, error) {
	if c == nil {
		return 0, fmt.Errorf("%w: nil catalog", ErrInvalidEdge)
	}
	type prepared struct {
		op EdgeOp
		e  Edge
	}
	prep := make([]prepared, 0, len(updates))
	for i, u := range updates {
		if u.Op != EdgeOpAdd && u.Op != EdgeOpRemove {
			return c.Version(), fmt.Errorf("update %d: unknown edge operation %d", i, u.Op)
		}
		if u.Op == EdgeOpRemove {
			id, err := edgeIDForRemoval(u.Edge)
			if err != nil {
				return c.Version(), fmt.Errorf("update %d: %w", i, err)
			}
			prep = append(prep, prepared{op: u.Op, e: Edge{ID: id}})
			continue
		}
		ne, err := u.Edge.normalized()
		if err != nil {
			return c.Version(), fmt.Errorf("update %d: %w", i, err)
		}
		prep = append(prep, prepared{op: u.Op, e: ne})
	}
	if len(prep) == 0 {
		return c.Version(), nil
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	cur := c.current.Load()
	nextNodes := maps.Clone(cur.nodes)
	nextEdges := maps.Clone(cur.edges)
	changed := false
	for _, p := range prep {
		switch p.op {
		case EdgeOpAdd:
			if old, ok := nextEdges[p.e.ID]; ok && edgesEqual(old, p.e) {
				continue
			}
			ensureEndpoints(nextNodes, p.e)
			nextEdges[p.e.ID] = p.e
			changed = true
		case EdgeOpRemove:
			if _, ok := nextEdges[p.e.ID]; ok {
				delete(nextEdges, p.e.ID)
				changed = true
			}
		}
	}
	if !changed {
		return cur.version, nil
	}
	v := c.publishLocked(nextNodes, nextEdges)
	return v, nil
}

// UpdateEdges is an alias for ApplyEdgeUpdates.
func (c *Catalog) UpdateEdges(updates ...EdgeUpdate) (uint64, error) {
	return c.ApplyEdgeUpdates(updates...)
}

// ClearEdges removes every edge while preserving nodes.
func (c *Catalog) ClearEdges() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	cur := c.current.Load()
	if len(cur.edges) == 0 {
		return
	}
	c.publishLocked(cur.nodes, map[EdgeID]Edge{})
}

func ensureEndpoints(nodes map[NodeID]Node, e Edge) {
	if _, ok := nodes[e.From]; !ok {
		n, _ := Node{ID: e.From, Type: NodeUnknown}.normalized()
		nodes[e.From] = n
	}
	if _, ok := nodes[e.To]; !ok {
		n, _ := Node{ID: e.To, Type: NodeUnknown}.normalized()
		nodes[e.To] = n
	}
}

func (c *Catalog) publishLocked(nodes map[NodeID]Node, edges map[EdgeID]Edge) uint64 {
	cur := c.current.Load()
	version := uint64(1)
	if cur != nil {
		version = cur.version + 1
	}
	s := buildSnapshot(version, nodes, edges)
	c.current.Store(s)
	c.history[version] = s
	c.pruneHistoryLocked()
	return version
}

func (c *Catalog) pruneHistoryLocked() {
	if c.historyLimit < 0 {
		return
	}
	if c.historyLimit == 0 {
		clear(c.history)
		c.history = make(map[uint64]*Snapshot)
		return
	}
	if len(c.history) <= c.historyLimit {
		return
	}
	versions := make([]uint64, 0, len(c.history))
	for v := range c.history {
		versions = append(versions, v)
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i] < versions[j] })
	excess := len(versions) - c.historyLimit
	for _, v := range versions[:excess] {
		delete(c.history, v)
	}
}
