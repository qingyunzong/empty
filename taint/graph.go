// Package taint implements context-aware taint analysis over a finite
// control-flow graph (CFG). Taint propagates along data dependencies
// (assignments) and conditional branches (implicit flow). Sanitizers
// remove taint only for the contexts they explicitly name. Loops are
// handled by computing a least fixpoint over the taint state.
package taint

import (
	"encoding/json"
	"fmt"
	"io"
)

// NodeKind classifies what a CFG node does to the taint state.
type NodeKind string

const (
	KindEntry    NodeKind = "entry"
	KindExit     NodeKind = "exit"
	KindNop      NodeKind = "nop"
	KindSource   NodeKind = "source"
	KindAssign   NodeKind = "assign"
	KindSanitize NodeKind = "sanitize"
	KindBranch   NodeKind = "branch"
	KindSink     NodeKind = "sink"
)

var knownKinds = map[NodeKind]bool{
	KindEntry:    true,
	KindExit:     true,
	KindNop:      true,
	KindSource:   true,
	KindAssign:   true,
	KindSanitize: true,
	KindBranch:   true,
	KindSink:     true,
}

// Node is a single CFG vertex.
//
//   - source:   introduces taint into Var (Contexts, default: all)
//   - assign:   Var := f(Uses...); strong update of Var
//   - sanitize: removes Contexts from Var's taint (other contexts survive)
//   - branch:   Uses are the condition variables (implicit-flow origin)
//   - sink:     leaks if Var is tainted in any of Contexts (default: all)
type Node struct {
	ID       string   `json:"id"`
	Kind     NodeKind `json:"kind"`
	Var      string   `json:"var,omitempty"`
	Uses     []string `json:"uses,omitempty"`
	Contexts []string `json:"contexts,omitempty"`
}

// Edge is a directed CFG edge; Label is informational (e.g. "true"/"false").
type Edge struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Label string `json:"label,omitempty"`
}

// Graph is a finite control-flow graph with taint-relevant annotations.
type Graph struct {
	Contexts []string `json:"contexts"`
	Entry    string   `json:"entry"`
	Nodes    []Node   `json:"nodes"`
	Edges    []Edge   `json:"edges"`

	byID  map[string]*Node
	preds map[string][]string
	succs map[string][]string
}

// Parse reads a graph from JSON and validates it.
func Parse(r io.Reader) (*Graph, error) {
	var g Graph
	if err := json.NewDecoder(r).Decode(&g); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	if err := g.validate(); err != nil {
		return nil, err
	}
	g.index()
	return &g, nil
}

func (g *Graph) validate() error {
	if len(g.Contexts) == 0 {
		return fmt.Errorf("contexts must list at least one taint context")
	}
	if len(g.Nodes) == 0 {
		return fmt.Errorf("graph has no nodes")
	}
	ctxOK := make(map[string]bool, len(g.Contexts))
	for _, c := range g.Contexts {
		ctxOK[c] = true
	}
	seen := make(map[string]bool, len(g.Nodes))
	for i := range g.Nodes {
		n := &g.Nodes[i]
		if n.ID == "" {
			return fmt.Errorf("node #%d: empty id", i)
		}
		if seen[n.ID] {
			return fmt.Errorf("duplicate node id %q", n.ID)
		}
		seen[n.ID] = true
		if !knownKinds[n.Kind] {
			return fmt.Errorf("node %q: unknown kind %q", n.ID, n.Kind)
		}
		switch n.Kind {
		case KindSource, KindAssign, KindSink:
			if n.Var == "" {
				return fmt.Errorf("node %q (%s): var is required", n.ID, n.Kind)
			}
		case KindSanitize:
			if n.Var == "" || len(n.Contexts) == 0 {
				return fmt.Errorf("node %q (sanitize): var and contexts are required", n.ID)
			}
		case KindBranch:
			if len(n.Uses) == 0 {
				return fmt.Errorf("node %q (branch): uses (condition variables) is required", n.ID)
			}
		}
		for _, c := range n.Contexts {
			if !ctxOK[c] {
				return fmt.Errorf("node %q: unknown context %q", n.ID, c)
			}
		}
	}
	if !seen[g.Entry] {
		return fmt.Errorf("entry node %q not found", g.Entry)
	}
	for _, e := range g.Edges {
		if !seen[e.From] {
			return fmt.Errorf("edge from unknown node %q", e.From)
		}
		if !seen[e.To] {
			return fmt.Errorf("edge to unknown node %q", e.To)
		}
	}
	return nil
}

func (g *Graph) index() {
	g.byID = make(map[string]*Node, len(g.Nodes))
	g.preds = make(map[string][]string, len(g.Nodes))
	g.succs = make(map[string][]string, len(g.Nodes))
	for i := range g.Nodes {
		g.byID[g.Nodes[i].ID] = &g.Nodes[i]
	}
	for _, e := range g.Edges {
		g.succs[e.From] = append(g.succs[e.From], e.To)
		g.preds[e.To] = append(g.preds[e.To], e.From)
	}
}
