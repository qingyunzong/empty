// Package logrule implements a log-processing engine whose rule set can be
// replaced dynamically. A replacement takes effect by record sequence
// number; every record is processed by exactly one rule generation; rule
// actions may derive diagnostic records, but a derived record never causes
// an ancestor record to be matched again; and derivation is bounded by an
// explicit depth budget. Processing a record yields a provenance tree.
package logrule

import (
	"fmt"
	"sort"
	"strings"
)

// Record is a log record or a derived diagnostic record.
type Record struct {
	Seq  uint64 // sequence number; selects the effective rule generation
	Kind string // record kind, e.g. "log" or "diag"
	Msg  string // message text
}

// Rule matches a record and may derive diagnostic records from it.
type Rule struct {
	Name  string
	Match func(Record) bool
	// Derive returns diagnostic records derived from rec. It is called only
	// when Match(rec) is true. Derived records are themselves matched
	// against rules, but they never cause rec (or any ancestor record) to
	// be matched again.
	Derive func(rec Record) []Record
}

// generation is an immutable snapshot of the rule set. All rules applied to
// a single record come from one generation.
type generation struct {
	id           int
	effectiveSeq uint64
	rules        []Rule
}

// Notes recorded on provenance tree nodes.
const (
	// NoteDepthBudget marks a node whose derived records were dropped
	// because the derivation depth budget was exhausted.
	NoteDepthBudget = "depth budget exhausted"
	// NoteRematch marks a derived record identical to an ancestor record.
	// It is kept in the tree for provenance but is never matched.
	NoteRematch = "re-match of ancestor suppressed"
)

// Node is one node of a provenance tree.
type Node struct {
	Record   Record   // the record this node processed
	Depth    int      // derivation depth; the original record has depth 0
	Gen      int      // id of the rule generation applied; -1 if none was effective
	Matched  []string // names of matched rules, in generation order
	Note     string   // "", NoteDepthBudget, or NoteRematch
	Children []*Node  // derived diagnostics, in derivation order
}

// Engine processes records against a replaceable, generationed rule set.
type Engine struct {
	maxDepth int
	gens     []generation // sorted by effectiveSeq
	nextID   int
}

// NewEngine returns an Engine with the given derivation depth budget: the
// maximum depth at which a derived record may exist. A budget of 0 disables
// derivation entirely; negative values are clamped to 0.
func NewEngine(maxDepth int) *Engine {
	if maxDepth < 0 {
		maxDepth = 0
	}
	return &Engine{maxDepth: maxDepth}
}

// ReplaceRules installs rules as the generation effective for records with
// Seq >= effectiveSeq. If a generation already exists at effectiveSeq, its
// rules are replaced in place (keeping its id); otherwise a new generation
// is created. The rules slice is copied.
func (e *Engine) ReplaceRules(effectiveSeq uint64, rules []Rule) {
	cp := make([]Rule, len(rules))
	copy(cp, rules)
	i := sort.Search(len(e.gens), func(i int) bool { return e.gens[i].effectiveSeq >= effectiveSeq })
	if i < len(e.gens) && e.gens[i].effectiveSeq == effectiveSeq {
		e.gens[i].rules = cp
		return
	}
	g := generation{id: e.nextID, effectiveSeq: effectiveSeq, rules: cp}
	e.nextID++
	e.gens = append(e.gens, generation{})
	copy(e.gens[i+1:], e.gens[i:])
	e.gens[i] = g
}

// generationFor returns the latest generation effective at seq, or a
// generation with id -1 and no rules if none is effective yet.
func (e *Engine) generationFor(seq uint64) generation {
	i := sort.Search(len(e.gens), func(i int) bool { return e.gens[i].effectiveSeq > seq })
	if i == 0 {
		return generation{id: -1}
	}
	return e.gens[i-1]
}

// Process matches rec against the rule generation effective at rec.Seq and
// expands derived diagnostics iteratively, returning the provenance tree.
// Its result is identical to the reference recursive interpreter Interpret.
func (e *Engine) Process(rec Record) *Node {
	type frame struct {
		node      *Node
		ancestors []Record // records on the path from the root to node, exclusive
	}
	root := &Node{Record: rec}
	stack := []frame{{node: root}}
	for len(stack) > 0 {
		f := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		n := f.node
		gen := e.generationFor(n.Record.Seq)
		n.Gen = gen.id
		if n.Depth > 0 && containsRecord(f.ancestors, n.Record) {
			n.Note = NoteRematch
			continue
		}
		var derived []Record
		for _, r := range gen.rules {
			if r.Match != nil && r.Match(n.Record) {
				n.Matched = append(n.Matched, r.Name)
				if r.Derive != nil {
					derived = append(derived, r.Derive(n.Record)...)
				}
			}
		}
		if len(derived) == 0 {
			continue
		}
		if n.Depth >= e.maxDepth {
			n.Note = NoteDepthBudget
			continue
		}
		childAncestors := append(append([]Record{}, f.ancestors...), n.Record)
		n.Children = make([]*Node, len(derived))
		for i, d := range derived {
			n.Children[i] = &Node{Record: d, Depth: n.Depth + 1}
		}
		for i := len(derived) - 1; i >= 0; i-- {
			stack = append(stack, frame{node: n.Children[i], ancestors: childAncestors})
		}
	}
	return root
}

// String renders the provenance tree rooted at n, one node per line,
// indented by depth.
func (n *Node) String() string {
	var b strings.Builder
	n.writeTo(&b, 0)
	return b.String()
}

func (n *Node) writeTo(b *strings.Builder, indent int) {
	fmt.Fprintf(b, "%*sdepth=%d gen=%d seq=%d kind=%q msg=%q matched=%v",
		indent*2, "", n.Depth, n.Gen, n.Record.Seq, n.Record.Kind, n.Record.Msg, n.Matched)
	if n.Note != "" {
		fmt.Fprintf(b, " note=%q", n.Note)
	}
	b.WriteByte('\n')
	for _, c := range n.Children {
		c.writeTo(b, indent+1)
	}
}
