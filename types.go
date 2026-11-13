package dataeng

import (
	"errors"
	"fmt"
	"maps"
	"strings"
)

// NodeID uniquely identifies a node in a catalog snapshot.
type NodeID string

// EdgeID uniquely identifies an edge in a catalog snapshot.
type EdgeID string

// NodeType describes what a lineage node represents.
type NodeType string

// EdgeType describes the relationship represented by an edge.  Edge types are
// part of the traversal state: two visits of the same node through different
// edge types are considered different states.
type EdgeType string

const (
	NodeUnknown NodeType = "unknown"
	NodeTable   NodeType = "table"
	NodeView    NodeType = "view"
	NodeJob     NodeType = "job"
	NodeCTE     NodeType = "cte"
	NodeDataset NodeType = "dataset"
	NodeFile    NodeType = "file"
	NodeModel   NodeType = "model"
)

// Short aliases for callers that prefer TypeTable style names.
const (
	TypeUnknown = NodeUnknown
	TypeTable   = NodeTable
	TypeView    = NodeView
	TypeJob     = NodeJob
	TypeCTE     = NodeCTE
	TypeDataset = NodeDataset
	TypeFile    = NodeFile
	TypeModel   = NodeModel
)

const (
	EdgeUnknown     EdgeType = "unknown"
	EdgeDerivedFrom EdgeType = "derived_from"
	EdgeFeeds       EdgeType = "feeds"
	EdgeReads       EdgeType = "reads"
	EdgeWrites      EdgeType = "writes"
	EdgeReferences  EdgeType = "references"
	EdgeDependsOn   EdgeType = "depends_on"
	EdgeCall        EdgeType = "call"
	EdgeRecursive   EdgeType = "recursive_reference"
)

// Short aliases for callers that prefer Kind* style names.
const (
	KindUnknown     = EdgeUnknown
	KindDerivedFrom = EdgeDerivedFrom
	KindFeeds       = EdgeFeeds
	KindReads       = EdgeReads
	KindWrites      = EdgeWrites
	KindReferences  = EdgeReferences
	KindDependsOn   = EdgeDependsOn
	KindCall        = EdgeCall
	KindRecursive   = EdgeRecursive
)

// Direction selects which side of an edge a traversal follows.
type Direction uint8

const (
	// Upstream follows incoming edges: node <- upstream node.
	Upstream Direction = iota
	// Downstream follows outgoing edges: node -> downstream node.
	Downstream
)

const (
	DirectionUpstream   = Upstream
	DirectionDownstream = Downstream
	DirUpstream         = Upstream
	DirDownstream       = Downstream
)

// UnlimitedDepth can be passed wherever a depth is accepted.  Traversal remains
// finite because the visited state is bounded by (node, edge type) pairs.
const UnlimitedDepth = -1

var (
	ErrNodeNotFound  = errors.New("lineage: node not found")
	ErrEdgeNotFound  = errors.New("lineage: edge not found")
	ErrInvalidNode   = errors.New("lineage: invalid node")
	ErrInvalidEdge   = errors.New("lineage: invalid edge")
	ErrVersionAbsent = errors.New("lineage: snapshot version not retained")
	ErrInvalidQuery  = errors.New("lineage: invalid query")
)

// ErrVersionNotFound is an alias for ErrVersionAbsent.
var ErrVersionNotFound = ErrVersionAbsent

// Node is an asset in the data catalog: a table, view, job, CTE, and so on.
//
// Type is the canonical field. Kind is accepted as an input alias so catalogs
// exported by other tools can be loaded without rewriting field names.
type Node struct {
	ID    NodeID            `json:"id"`
	Type  NodeType          `json:"type,omitempty"`
	Kind  NodeType          `json:"kind,omitempty"`
	Name  string            `json:"name,omitempty"`
	Label string            `json:"label,omitempty"`
	Attrs map[string]string `json:"attrs,omitempty"`
}

func (n Node) normalized() (Node, error) {
	n.ID = NodeID(strings.TrimSpace(string(n.ID)))
	if n.ID == "" {
		return Node{}, fmt.Errorf("%w: empty id", ErrInvalidNode)
	}
	if n.Type == "" {
		n.Type = n.Kind
	}
	if n.Type == "" {
		n.Type = NodeUnknown
	}
	n.Kind = n.Type
	if n.Name == "" {
		n.Name = n.Label
	}
	n.Label = n.Name
	n.Attrs = cloneAttrs(n.Attrs)
	return n, nil
}

// Edge is a directed lineage relationship. The direction is dataflow
// direction: From is the upstream producer and To is the downstream consumer.
//
//	raw_orders --derived_from--> clean_orders --derived_from--> daily_report
//
// Upstream(daily_report) visits clean_orders and then raw_orders.
//
// Source/Target, Upstream/Downstream, and Kind are accepted as aliases for
// From/To and Type.
type Edge struct {
	ID         EdgeID            `json:"id,omitempty"`
	From       NodeID            `json:"from"`
	To         NodeID            `json:"to"`
	Type       EdgeType          `json:"type,omitempty"`
	Source     NodeID            `json:"source,omitempty"`
	Target     NodeID            `json:"target,omitempty"`
	Upstream   NodeID            `json:"upstream,omitempty"`
	Downstream NodeID            `json:"downstream,omitempty"`
	Kind       EdgeType          `json:"kind,omitempty"`
	Attrs      map[string]string `json:"attrs,omitempty"`
}

func (e Edge) normalized() (Edge, error) {
	if e.From == "" {
		e.From = e.Source
		if e.From == "" {
			e.From = e.Upstream
		}
	}
	if e.To == "" {
		e.To = e.Target
		if e.To == "" {
			e.To = e.Downstream
		}
	}
	if e.Type == "" {
		e.Type = e.Kind
	}
	e.From = NodeID(strings.TrimSpace(string(e.From)))
	e.To = NodeID(strings.TrimSpace(string(e.To)))
	if e.From == "" || e.To == "" {
		return Edge{}, fmt.Errorf("%w: both endpoints are required", ErrInvalidEdge)
	}
	if e.Type == "" {
		e.Type = EdgeUnknown
	}
	e.Source = e.From
	e.Target = e.To
	e.Upstream = e.From
	e.Downstream = e.To
	e.Kind = e.Type
	if e.ID == "" {
		e.ID = EdgeID(string(e.From) + "\x1f" + string(e.Type) + "\x1f" + string(e.To))
	}
	e.ID = EdgeID(strings.TrimSpace(string(e.ID)))
	if e.ID == "" {
		return Edge{}, fmt.Errorf("%w: empty id", ErrInvalidEdge)
	}
	e.Attrs = cloneAttrs(e.Attrs)
	return e, nil
}

// GeneratedEdgeID returns the deterministic ID used when Edge.ID is empty.
func GeneratedEdgeID(from, to NodeID, typ EdgeType) EdgeID {
	return EdgeID(string(from) + "\x1f" + string(typ) + "\x1f" + string(to))
}

func edgeIDForRemoval(e Edge) (EdgeID, error) {
	if e.ID != "" && e.From == "" && e.To == "" {
		return EdgeID(strings.TrimSpace(string(e.ID))), nil
	}
	ne, err := e.normalized()
	if err != nil {
		return "", err
	}
	return ne.ID, nil
}

func cloneAttrs(src map[string]string) map[string]string {
	if len(src) == 0 {
		return nil
	}
	return maps.Clone(src)
}

func cloneNode(n Node) Node {
	n.Attrs = cloneAttrs(n.Attrs)
	return n
}

func cloneEdge(e Edge) Edge {
	e.Attrs = cloneAttrs(e.Attrs)
	return e
}

func nodesEqual(a, b Node) bool {
	return a.ID == b.ID &&
		a.Type == b.Type &&
		a.Name == b.Name &&
		maps.Equal(a.Attrs, b.Attrs)
}

func edgesEqual(a, b Edge) bool {
	return a.ID == b.ID &&
		a.From == b.From &&
		a.To == b.To &&
		a.Type == b.Type &&
		maps.Equal(a.Attrs, b.Attrs)
}
