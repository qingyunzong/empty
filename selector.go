// Package dataeng evaluates selector expressions against a read-only element
// tree.
//
// An expression is one or more complete paths joined with '|'; the result is
// the document-order union of every path result. A path is a '/' separated
// sequence of steps; the first step matches the children of the virtual root
// supplied at evaluation time. A step is a tag name or '*' (any tag),
// optionally followed by a single positional predicate, either '[n]' with n a
// positive decimal integer or '[last()]'. A '//' separator makes the
// following step match every descendant of the current nodes instead of only
// their children.
//
// Positional predicates are computed independently for the candidate set of
// each input node (candidates in document preorder); the per-node results are
// then merged, deduplicated and returned in document order. They are never
// applied after the candidate sets have been merged.
//
// Because the first step always starts at the children of the virtual root,
// a leading '/' or "//" is a syntax error. Empty steps, trailing separators
// and any other malformed construct report the zero-based byte offset where
// the violation begins; compilation fails before any tree is walked.
package dataeng

import (
	"fmt"
	"sort"
	"strconv"
)

// Node is an element of the read-only element tree. IDs are unique within a
// tree. Children are stored in document order. The caller guarantees that the
// tree is acyclic; this package never mutates a node or its children.
type Node struct {
	ID       int
	Tag      string
	Children []*Node
}

// ParseError describes a malformed selector expression. Offset is the
// zero-based byte position in the original expression at which the syntax
// violation starts.
type ParseError struct {
	Offset int
	Msg    string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("selector: syntax error at byte %d: %s", e.Offset, e.Msg)
}

// Axis selects how a step reaches its candidates from an input node.
type axis int

const (
	childAxis axis = iota
	descendantAxis
)

// kind distinguishes the positional predicate forms.
type kind int

const (
	noneKind kind = iota
	indexKind
	lastKind
)

type predicate struct {
	kind  kind
	index int // one-based position, valid for indexKind
}

type step struct {
	axis axis
	name string // tag name, or "" for '*'
	any  bool
	pred predicate
}

type compiledPath struct {
	steps []step
}

// Selector is a compiled, immutable expression. Compile once and call Eval as
// many times as needed, including concurrently on different trees.
type Selector struct {
	paths []compiledPath
}

// Compile parses expr and returns a reusable Selector. On a syntax error no
// tree work has happened; the returned ParseError carries the zero-based byte
// offset where the violation starts.
func Compile(expr string) (*Selector, error) {
	if expr == "" {
		return nil, &ParseError{Offset: 0, Msg: "empty expression"}
	}

	sel := &Selector{}
	base := 0
	for {
		pipe := indexByteFrom(expr, '|', base)
		segment := expr[base:pipe]
		path, err := parsePath(segment, base)
		if err != nil {
			return nil, err
		}
		sel.paths = append(sel.paths, path)

		if pipe == len(expr) {
			return sel, nil
		}
		base = pipe + 1
	}
}

// MustCompile is like Compile but panics on a syntax error.
func MustCompile(expr string) *Selector {
	sel, err := Compile(expr)
	if err != nil {
		panic(err)
	}
	return sel
}

// parsePath parses one '|'-free path segment. segmentBase is the byte offset
// of the segment in the full expression so error offsets stay absolute.
func parsePath(segment string, segmentBase int) (compiledPath, error) {
	if segment == "" {
		return compiledPath{}, &ParseError{Offset: segmentBase, Msg: "empty path"}
	}

	path := compiledPath{}
	pos := 0
	ax := childAxis

	for {
		if pos >= len(segment) {
			// A trailing separator ('/' or "//") leaves an empty step.
			return compiledPath{}, &ParseError{Offset: segmentBase + pos, Msg: "empty step"}
		}

		st, next, err := parseStep(segment, pos, segmentBase)
		if err != nil {
			return compiledPath{}, err
		}
		st.axis = ax
		path.steps = append(path.steps, st)

		if next == len(segment) {
			return path, nil
		}

		// next points at the separator after the parsed step.
		if segment[next] != '/' {
			return compiledPath{}, &ParseError{Offset: segmentBase + next, Msg: "expected '/' between steps"}
		}

		if next+1 < len(segment) && segment[next+1] == '/' {
			ax = descendantAxis
			pos = next + 2
		} else {
			ax = childAxis
			pos = next + 1
		}
		if pos >= len(segment) {
			return compiledPath{}, &ParseError{Offset: segmentBase + pos, Msg: "empty step"}
		}
	}
}

// parseStep parses a tag/'*' plus its optional predicate starting at pos.
func parseStep(segment string, pos, segmentBase int) (step, int, error) {
	st := step{}

	if segment[pos] == '*' {
		st.any = true
		pos++
	} else {
		start := pos
		for pos < len(segment) && isNameByte(segment[pos]) {
			pos++
		}
		if pos == start {
			return step{}, 0, &ParseError{Offset: segmentBase + start, Msg: "expected tag name or '*'"}
		}
		st.name = segment[start:pos]
	}

	if pos >= len(segment) || segment[pos] != '[' {
		return st, pos, nil
	}

	// Parse exactly one predicate: '[' body ']'.
	bodyStart := pos + 1
	close := indexByteFrom(segment, ']', bodyStart)
	if close == len(segment) {
		return step{}, 0, &ParseError{Offset: segmentBase + pos, Msg: "unterminated predicate"}
	}
	if indexByteFrom(segment, '[', bodyStart) < close {
		return step{}, 0, &ParseError{Offset: segmentBase + pos, Msg: "nested or repeated predicate"}
	}

	body := segment[bodyStart:close]
	if body == "" {
		return step{}, 0, &ParseError{Offset: segmentBase + bodyStart, Msg: "empty predicate"}
	}

	if isPositiveDecimal(body) {
		n, err := strconv.Atoi(body)
		if err != nil {
			return step{}, 0, &ParseError{
				Offset: segmentBase + bodyStart,
				Msg:    "predicate index out of range",
			}
		}
		st.pred = predicate{kind: indexKind, index: n}
	} else if body == "last()" {
		st.pred = predicate{kind: lastKind}
	} else {
		return step{}, 0, &ParseError{
			Offset: segmentBase + bodyStart,
			Msg:    "predicate must be [n] or [last()]",
		}
	}

	after := close + 1
	if after < len(segment) && segment[after] == '[' {
		return step{}, 0, &ParseError{Offset: segmentBase + after, Msg: "only one predicate per step is allowed"}
	}
	return st, after, nil
}

// isNameByte reports whether b may appear inside a tag name. Everything that
// has structural meaning in the grammar is excluded.
func isNameByte(b byte) bool {
	switch b {
	case '/', '|', '[', ']', '*', '(', ')', ' ', '\t', '\r', '\n':
		return false
	}
	return b >= ' ' // rejects control characters and the NUL byte
}

func isPositiveDecimal(s string) bool {
	if s == "" || s[0] == '0' {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func indexByteFrom(s string, b byte, from int) int {
	for i := from; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return len(s)
}

// Eval runs the compiled expression against the tree rooted at virtualRoot and
// returns the matched nodes in document order, deduplicated. virtualRoot
// itself is never returned; the first step only matches its children.
func (s *Selector) Eval(virtualRoot *Node) []*Node {
	if s == nil || virtualRoot == nil {
		return nil
	}

	order := make(map[int]int)
	assignPreorder(virtualRoot, 0, order)

	seen := make(map[int]bool)
	var matched []*Node

	for i := range s.paths {
		for _, node := range evalPath(&s.paths[i], virtualRoot) {
			if !seen[node.ID] {
				seen[node.ID] = true
				matched = append(matched, node)
			}
		}
	}

	sort.SliceStable(matched, func(i, j int) bool {
		return order[matched[i].ID] < order[matched[j].ID]
	})
	return matched
}

// EvalIDs is a convenience wrapper returning the unique node IDs in document
// order.
func (s *Selector) EvalIDs(virtualRoot *Node) []int {
	nodes := s.Eval(virtualRoot)
	ids := make([]int, len(nodes))
	for i, node := range nodes {
		ids[i] = node.ID
	}
	return ids
}

// assignPreorder assigns each node a document preorder position. The virtual
// root itself is assigned a position too; only relative ordering matters.
func assignPreorder(node *Node, next int, order map[int]int) int {
	order[node.ID] = next
	next++
	for _, child := range node.Children {
		next = assignPreorder(child, next, order)
	}
	return next
}

// evalPath applies a single compiled path starting from virtualRoot.
func evalPath(path *compiledPath, virtualRoot *Node) []*Node {
	current := []*Node{virtualRoot}
	for stepIndex := range path.steps {
		st := &path.steps[stepIndex]
		var next []*Node
		for _, input := range current {
			candidates := collectCandidates(st, input)
			next = append(next, applyPredicate(st.pred, candidates)...)
		}
		current = next
		if len(current) == 0 {
			return nil
		}
	}
	return current
}

// collectCandidates returns the matching candidates for one input node in
// document preorder, without applying the positional predicate.
func collectCandidates(st *step, input *Node) []*Node {
	if st.axis == childAxis {
		var candidates []*Node
		for _, child := range input.Children {
			if st.any || child.Tag == st.name {
				candidates = append(candidates, child)
			}
		}
		return candidates
	}

	var candidates []*Node
	var walk func(node *Node)
	walk = func(node *Node) {
		for _, child := range node.Children {
			if st.any || child.Tag == st.name {
				candidates = append(candidates, child)
			}
			walk(child)
		}
	}
	walk(input)
	return candidates
}

// applyPredicate selects by position within this single candidate set. The
// caller passes the candidates of one input node only, so the position is
// always relative to that node rather than to the merged union.
func applyPredicate(pred predicate, candidates []*Node) []*Node {
	switch pred.kind {
	case noneKind:
		return candidates
	case indexKind:
		if pred.index < 1 || pred.index > len(candidates) {
			return nil
		}
		return []*Node{candidates[pred.index-1]}
	case lastKind:
		if len(candidates) == 0 {
			return nil
		}
		return []*Node{candidates[len(candidates)-1]}
	default:
		return candidates
	}
}

// Paths reports the number of complete paths joined by '|' in the selector.
func (s *Selector) Paths() int {
	if s == nil {
		return 0
	}
	return len(s.paths)
}
