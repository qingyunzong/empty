package dataeng

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

// CatalogData is the portable JSON form of a catalog snapshot.
type CatalogData struct {
	Version uint64 `json:"version,omitempty"`
	Nodes   []Node `json:"nodes"`
	Edges   []Edge `json:"edges"`
}

// CatalogFile is an alias for CatalogData.
type CatalogFile = CatalogData

// Export returns a detached JSON-ready representation of this snapshot.
func (s *Snapshot) Export() CatalogData {
	if s == nil {
		return CatalogData{}
	}
	return CatalogData{Version: s.version, Nodes: s.Nodes(), Edges: s.Edges()}
}

// Export returns a detached JSON-ready representation of the current snapshot.
func (c *Catalog) Export() CatalogData {
	if c == nil {
		return CatalogData{}
	}
	return c.Snapshot().Export()
}

// MarshalJSON encodes a snapshot in catalog-file form.
func (s *Snapshot) MarshalJSON() ([]byte, error) {
	return json.Marshal(s.Export())
}

// MarshalJSON encodes the current snapshot in catalog-file form.
func (c *Catalog) MarshalJSON() ([]byte, error) {
	return json.Marshal(c.Export())
}

// LoadJSON decodes a catalog file into a new catalog.
func LoadJSON(r io.Reader) (*Catalog, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("lineage: read catalog: %w", err)
	}
	return ParseJSON(data)
}

// LoadCatalogJSON is an alias for LoadJSON.
func LoadCatalogJSON(r io.Reader) (*Catalog, error) { return LoadJSON(r) }

// ParseJSON decodes catalog JSON.
func ParseJSON(data []byte) (*Catalog, error) {
	var cd CatalogData
	dec := json.NewDecoder(bytes.NewReader(data))
	if err := dec.Decode(&cd); err != nil {
		return nil, fmt.Errorf("lineage: decode catalog: %w", err)
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("lineage: decode catalog: trailing data")
		}
		return nil, fmt.Errorf("lineage: decode catalog: %w", err)
	}
	return newCatalogFromData(cd)
}

// ParseCatalogJSON is an alias for ParseJSON.
func ParseCatalogJSON(data []byte) (*Catalog, error) { return ParseJSON(data) }

func newCatalogFromData(cd CatalogData) (*Catalog, error) {
	nodes := make(map[NodeID]Node, len(cd.Nodes))
	for i, n := range cd.Nodes {
		nn, err := n.normalized()
		if err != nil {
			return nil, fmt.Errorf("node %d: %w", i, err)
		}
		nodes[nn.ID] = nn
	}
	edges := make(map[EdgeID]Edge, len(cd.Edges))
	for i, e := range cd.Edges {
		ne, err := e.normalized()
		if err != nil {
			return nil, fmt.Errorf("edge %d: %w", i, err)
		}
		ensureEndpoints(nodes, ne)
		edges[ne.ID] = ne
	}

	version := cd.Version
	if version == 0 && (len(nodes) > 0 || len(edges) > 0) {
		version = 1
	}
	c := &Catalog{
		history:      make(map[uint64]*Snapshot),
		historyLimit: -1,
	}
	s := buildSnapshot(version, nodes, edges)
	c.current.Store(s)
	c.history[version] = s
	return c, nil
}

// MarshalJSON emits canonical field names rather than the accepted aliases.
func (n Node) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		ID    NodeID            `json:"id"`
		Type  NodeType          `json:"type,omitempty"`
		Name  string            `json:"name,omitempty"`
		Attrs map[string]string `json:"attrs,omitempty"`
	}{ID: n.ID, Type: n.Type, Name: n.Name, Attrs: n.Attrs})
}

// UnmarshalJSON accepts type/kind and name/label aliases.
func (n *Node) UnmarshalJSON(data []byte) error {
	var raw struct {
		ID    NodeID            `json:"id"`
		Type  NodeType          `json:"type"`
		Kind  NodeType          `json:"kind"`
		Name  string            `json:"name"`
		Label string            `json:"label"`
		Attrs map[string]string `json:"attrs"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*n = Node{ID: raw.ID, Type: raw.Type, Kind: raw.Kind, Name: raw.Name, Label: raw.Label, Attrs: raw.Attrs}
	return nil
}

// MarshalJSON emits canonical field names rather than the accepted aliases.
func (e Edge) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		ID    EdgeID            `json:"id,omitempty"`
		From  NodeID            `json:"from"`
		To    NodeID            `json:"to"`
		Type  EdgeType          `json:"type,omitempty"`
		Attrs map[string]string `json:"attrs,omitempty"`
	}{ID: e.ID, From: e.From, To: e.To, Type: e.Type, Attrs: e.Attrs})
}

// UnmarshalJSON accepts from/source/upstream, to/target/downstream, and
// type/kind aliases.
func (e *Edge) UnmarshalJSON(data []byte) error {
	var raw struct {
		ID         EdgeID            `json:"id"`
		From       NodeID            `json:"from"`
		To         NodeID            `json:"to"`
		Source     NodeID            `json:"source"`
		Target     NodeID            `json:"target"`
		Upstream   NodeID            `json:"upstream"`
		Downstream NodeID            `json:"downstream"`
		Type       EdgeType          `json:"type"`
		Kind       EdgeType          `json:"kind"`
		Attrs      map[string]string `json:"attrs"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*e = Edge{
		ID:         raw.ID,
		From:       raw.From,
		To:         raw.To,
		Source:     raw.Source,
		Target:     raw.Target,
		Upstream:   raw.Upstream,
		Downstream: raw.Downstream,
		Type:       raw.Type,
		Kind:       raw.Kind,
		Attrs:      raw.Attrs,
	}
	return nil
}
