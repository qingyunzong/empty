package dataeng

import (
	"sort"
)

// Snapshot is an immutable view of a catalog at one version.  Queries load one
// snapshot and never consult the live catalog again, so a single query cannot
// mix edges from two different versions.
type Snapshot struct {
	version uint64
	nodes   map[NodeID]Node
	edges   map[EdgeID]Edge
	out     map[NodeID][]Edge
	in      map[NodeID][]Edge
	nodeIDs []NodeID
	edgeIDs []EdgeID
}

func buildSnapshot(version uint64, nodes map[NodeID]Node, edges map[EdgeID]Edge) *Snapshot {
	s := &Snapshot{
		version: version,
		nodes:   nodes,
		edges:   edges,
		out:     make(map[NodeID][]Edge, len(nodes)),
		in:      make(map[NodeID][]Edge, len(nodes)),
		nodeIDs: make([]NodeID, 0, len(nodes)),
		edgeIDs: make([]EdgeID, 0, len(edges)),
	}
	for id := range nodes {
		s.nodeIDs = append(s.nodeIDs, id)
	}
	sort.Slice(s.nodeIDs, func(i, j int) bool { return s.nodeIDs[i] < s.nodeIDs[j] })

	for id, e := range edges {
		s.edgeIDs = append(s.edgeIDs, id)
		s.out[e.From] = append(s.out[e.From], e)
		s.in[e.To] = append(s.in[e.To], e)
	}
	sort.Slice(s.edgeIDs, func(i, j int) bool { return s.edgeIDs[i] < s.edgeIDs[j] })

	for id := range s.out {
		es := s.out[id]
		sort.SliceStable(es, func(i, j int) bool {
			if es[i].To != es[j].To {
				return es[i].To < es[j].To
			}
			if es[i].Type != es[j].Type {
				return es[i].Type < es[j].Type
			}
			return es[i].ID < es[j].ID
		})
	}
	for id := range s.in {
		es := s.in[id]
		sort.SliceStable(es, func(i, j int) bool {
			if es[i].From != es[j].From {
				return es[i].From < es[j].From
			}
			if es[i].Type != es[j].Type {
				return es[i].Type < es[j].Type
			}
			return es[i].ID < es[j].ID
		})
	}
	return s
}

// Version returns the catalog version captured by this snapshot. Version zero
// is the empty catalog.
func (s *Snapshot) Version() uint64 {
	if s == nil {
		return 0
	}
	return s.version
}

// Len returns the number of nodes in the snapshot.
func (s *Snapshot) Len() int {
	if s == nil {
		return 0
	}
	return len(s.nodes)
}

// NodeCount returns the number of nodes in the snapshot.
func (s *Snapshot) NodeCount() int { return s.Len() }

// EdgeCount returns the number of edges in the snapshot.
func (s *Snapshot) EdgeCount() int {
	if s == nil {
		return 0
	}
	return len(s.edges)
}

// HasNode reports whether id exists in this snapshot.
func (s *Snapshot) HasNode(id NodeID) bool {
	if s == nil {
		return false
	}
	_, ok := s.nodes[id]
	return ok
}

// Node returns a copy of the node with id.
func (s *Snapshot) Node(id NodeID) (Node, bool) {
	if s == nil {
		return Node{}, false
	}
	n, ok := s.nodes[id]
	if !ok {
		return Node{}, false
	}
	return cloneNode(n), true
}

// GetNode is an alias for Node.
func (s *Snapshot) GetNode(id NodeID) (Node, bool) { return s.Node(id) }

// NodeIDs returns node IDs in deterministic order.
func (s *Snapshot) NodeIDs() []NodeID {
	if s == nil {
		return nil
	}
	return append([]NodeID(nil), s.nodeIDs...)
}

// Nodes returns all nodes in deterministic ID order.
func (s *Snapshot) Nodes() []Node {
	if s == nil {
		return nil
	}
	out := make([]Node, 0, len(s.nodeIDs))
	for _, id := range s.nodeIDs {
		out = append(out, cloneNode(s.nodes[id]))
	}
	return out
}

// Edge returns a copy of the edge with id.
func (s *Snapshot) Edge(id EdgeID) (Edge, bool) {
	if s == nil {
		return Edge{}, false
	}
	e, ok := s.edges[id]
	if !ok {
		return Edge{}, false
	}
	return cloneEdge(e), true
}

// GetEdge is an alias for Edge.
func (s *Snapshot) GetEdge(id EdgeID) (Edge, bool) { return s.Edge(id) }

// HasEdge reports whether id exists in this snapshot.
func (s *Snapshot) HasEdge(id EdgeID) bool {
	if s == nil {
		return false
	}
	_, ok := s.edges[id]
	return ok
}

// EdgeIDs returns edge IDs in deterministic order.
func (s *Snapshot) EdgeIDs() []EdgeID {
	if s == nil {
		return nil
	}
	return append([]EdgeID(nil), s.edgeIDs...)
}

// Edges returns all edges in deterministic ID order.
func (s *Snapshot) Edges() []Edge {
	if s == nil {
		return nil
	}
	out := make([]Edge, 0, len(s.edgeIDs))
	for _, id := range s.edgeIDs {
		out = append(out, cloneEdge(s.edges[id]))
	}
	return out
}

// Outgoing returns edges whose From endpoint is id.  The result is sorted by
// downstream node, edge type, then edge ID.
func (s *Snapshot) Outgoing(id NodeID) []Edge {
	if s == nil {
		return nil
	}
	es := s.out[id]
	out := make([]Edge, 0, len(es))
	for _, e := range es {
		out = append(out, cloneEdge(e))
	}
	return out
}

// Incoming returns edges whose To endpoint is id.  The result is sorted by
// upstream node, edge type, then edge ID.
func (s *Snapshot) Incoming(id NodeID) []Edge {
	if s == nil {
		return nil
	}
	es := s.in[id]
	out := make([]Edge, 0, len(es))
	for _, e := range es {
		out = append(out, cloneEdge(e))
	}
	return out
}

// FindEdges returns edges matching the non-empty filters.  An empty filter
// matches anything.
func (s *Snapshot) FindEdges(from, to NodeID, typ EdgeType) []Edge {
	if s == nil {
		return nil
	}
	var out []Edge
	for _, id := range s.edgeIDs {
		e := s.edges[id]
		if from != "" && e.From != from {
			continue
		}
		if to != "" && e.To != to {
			continue
		}
		if typ != "" && e.Type != typ {
			continue
		}
		out = append(out, cloneEdge(e))
	}
	return out
}

func (s *Snapshot) outgoingRaw(id NodeID) []Edge {
	if s == nil {
		return nil
	}
	return s.out[id]
}

func (s *Snapshot) incomingRaw(id NodeID) []Edge {
	if s == nil {
		return nil
	}
	return s.in[id]
}
