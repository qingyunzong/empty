// Package taint implements a taint analysis over a limited control-flow
// graph: taint propagates along data dependencies and conditional branches,
// sanitizers are only effective for their declared contexts, and loops are
// resolved by least fixed-point iteration.
package taint

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
)

// Node kinds.
const (
	KindAssign   = "assign"   // var = f(uses...)
	KindSource   = "source"   // var = tainted input
	KindSanitize = "sanitize" // var = clean(arg) for the listed contexts only
	KindSink     = "sink"     // sensitive call consuming args in context
	KindBranch   = "branch"   // conditional using uses; taints implicit flow
)

// Node is a single CFG vertex.
type Node struct {
	ID       string   `json:"id"`
	Kind     string   `json:"kind"`
	Var      string   `json:"var,omitempty"`      // assign/source/sanitize: defined variable
	Uses     []string `json:"uses,omitempty"`     // assign: rhs vars; branch: condition vars
	Arg      string   `json:"arg,omitempty"`      // sanitize: input variable
	Args     []string `json:"args,omitempty"`     // sink: consumed variables
	Contexts []string `json:"contexts,omitempty"` // sanitize: contexts it cleans
	Context  string   `json:"context,omitempty"`  // sink: required safe context
	Next     string   `json:"next,omitempty"`
	Then     string   `json:"then,omitempty"`
	Else     string   `json:"else,omitempty"`
}

// Program is a limited control-flow graph with a single entry.
type Program struct {
	Entry string `json:"entry"`
	Nodes []Node `json:"nodes"`

	byID map[string]*Node
	pred map[string][]string
	succ map[string][]string
}

// Load parses a program from JSON and validates its structure.
func Load(r io.Reader) (*Program, error) {
	var p Program
	if err := json.NewDecoder(r).Decode(&p); err != nil {
		return nil, fmt.Errorf("parse program: %w", err)
	}
	if err := p.index(); err != nil {
		return nil, err
	}
	return &p, nil
}

func (p *Program) index() error {
	p.byID = make(map[string]*Node, len(p.Nodes))
	p.pred = make(map[string][]string)
	p.succ = make(map[string][]string)
	for i := range p.Nodes {
		n := &p.Nodes[i]
		if n.ID == "" {
			return fmt.Errorf("node %d: empty id", i)
		}
		if _, dup := p.byID[n.ID]; dup {
			return fmt.Errorf("duplicate node id %q", n.ID)
		}
		switch n.Kind {
		case KindAssign, KindSource, KindSanitize, KindSink, KindBranch:
		default:
			return fmt.Errorf("node %q: unknown kind %q", n.ID, n.Kind)
		}
		p.byID[n.ID] = n
	}
	if _, ok := p.byID[p.Entry]; !ok {
		return fmt.Errorf("entry node %q not found", p.Entry)
	}
	edge := func(from, to string) error {
		if to == "" {
			return nil
		}
		if _, ok := p.byID[to]; !ok {
			return fmt.Errorf("node %q: successor %q not found", from, to)
		}
		p.succ[from] = append(p.succ[from], to)
		p.pred[to] = append(p.pred[to], from)
		return nil
	}
	for i := range p.Nodes {
		n := &p.Nodes[i]
		if n.Kind == KindBranch {
			if n.Then == "" || n.Else == "" {
				return fmt.Errorf("branch node %q: then/else required", n.ID)
			}
			if err := edge(n.ID, n.Then); err != nil {
				return err
			}
			if err := edge(n.ID, n.Else); err != nil {
				return err
			}
		} else if err := edge(n.ID, n.Next); err != nil {
			return err
		}
	}
	return nil
}

// Node returns the node with the given id.
func (p *Program) Node(id string) *Node { return p.byID[id] }

// Succ returns successor ids of a node.
func (p *Program) Succ(id string) []string { return p.succ[id] }

// Pred returns predecessor ids of a node.
func (p *Program) Pred(id string) []string { return p.pred[id] }

// IDs returns all node ids in declaration order.
func (p *Program) IDs() []string {
	ids := make([]string, len(p.Nodes))
	for i := range p.Nodes {
		ids[i] = p.Nodes[i].ID
	}
	return ids
}

// universe collects every context mentioned by sanitizers and sinks, plus
// the default context. Taint facts are subsets of this finite universe,
// which is what makes the fixed-point iteration terminate.
func (p *Program) universe() []string {
	seen := map[string]bool{"default": true}
	for i := range p.Nodes {
		n := &p.Nodes[i]
		for _, c := range n.Contexts {
			seen[c] = true
		}
		if n.Context != "" {
			seen[n.Context] = true
		}
	}
	u := make([]string, 0, len(seen))
	for c := range seen {
		u = append(u, c)
	}
	sort.Strings(u)
	return u
}
