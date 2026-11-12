// Package dataeng parses JSON object streams for log-collection hosts while
// preserving information that the standard library discards.
//
// Duplicate object keys are legal: every occurrence is retained, in order, so
// the parsed result is an ordered key/value tree rather than a map. Numbers
// keep both their original lexical form and an exact *big.Rat value. Strings
// are validated as strict UTF-8, including explicit checks for unpaired UTF-16
// surrogate code points.
package dataeng

// Kind identifies the JSON value type held by a Node.
type Kind int

const (
	KindObject Kind = iota + 1
	KindArray
	KindString
	KindNumber
	KindBool
	KindNull
)

func (k Kind) String() string {
	switch k {
	case KindObject:
		return "object"
	case KindArray:
		return "array"
	case KindString:
		return "string"
	case KindNumber:
		return "number"
	case KindBool:
		return "bool"
	case KindNull:
		return "null"
	default:
		return "unknown"
	}
}

// Member is a single object entry. Objects hold a slice of members so that
// duplicate keys and insertion order are both preserved.
type Member struct {
	Key   string
	Value *Node
}

// Node is one node of the ordered JSON tree. Exactly one of the typed value
// fields is meaningful depending on Kind; composites use Members or Elems.
type Node struct {
	Kind Kind

	// Members holds object entries in source order, including duplicate keys.
	Members []Member
	// Elems holds array elements in source order.
	Elems []*Node

	// Str is the decoded string value for KindString.
	Str string
	// Num is the exact number value for KindNumber.
	Num *Number
	// Bool is the value for KindBool.
	Bool bool
}

// AllOccurrences may be used as PathStep.Occurrence to request every
// occurrence of a duplicated field instead of a single one.
const AllOccurrences = 0

// PathStep is one typed step of a tree path. A step selects either an object
// field (IsIndex == false) or an array element (IsIndex == true).
//
// For field steps, Occurrence is 1-based. Occurrence == AllOccurrences selects
// every member carrying the field name, while a positive value selects the
// nth occurrence among duplicate keys.
//
// For index steps, Index is a zero-based array position.
type PathStep struct {
	// Field is the object member name; meaningful when IsIndex is false.
	Field string
	// Occurrence is the 1-based duplicate selector; 0 means all occurrences.
	Occurrence int

	// IsIndex marks an array index step.
	IsIndex bool
	// Index is the zero-based array position.
	Index int
}

// FieldStep builds an object-field step. occurrence is 1-based; pass
// AllOccurrences to select every duplicate of the field.
func FieldStep(field string, occurrence int) PathStep {
	return PathStep{Field: field, Occurrence: occurrence}
}

// IndexStep builds a zero-based array-index step.
func IndexStep(index int) PathStep {
	return PathStep{IsIndex: true, Index: index}
}

// QueryResult is the outcome of a path lookup. Missing paths are reported as
// Found == false; a JSON null that exists yields Found == true with a node of
// KindNull, so callers never confuse absence with an explicit null.
type QueryResult struct {
	// Node is the matched node, or nil when nothing matched.
	Node *Node
	// Found reports whether the path resolved to at least one node.
	Found bool
	// All holds every matched node, including single-match lookups.
	All []*Node
}

// IsMissing reports whether the path did not resolve to any value.
func (r QueryResult) IsMissing() bool { return !r.Found }

// Values returns the matched nodes (nil when missing).
func (r QueryResult) Values() []*Node { return r.All }

var missingResult = QueryResult{}

// QueryPath walks root following the typed steps and reports the match.
// A field step whose object does not contain the requested field (or whose
// occurrence number is out of range), and an array index that is out of
// range or applied to a non-array, produce a missing result rather than null.
func QueryPath(root *Node, steps ...PathStep) QueryResult {
	if root == nil {
		return missingResult
	}
	current := []*Node{root}
	for _, step := range steps {
		var next []*Node
		for _, node := range current {
			next = append(next, applyStep(node, step)...)
		}
		current = next
		if len(current) == 0 {
			return missingResult
		}
	}
	return QueryResult{Node: current[0], Found: true, All: current}
}

// Query runs QueryPath starting at this node.
func (n *Node) Query(steps ...PathStep) QueryResult {
	return QueryPath(n, steps...)
}

func applyStep(node *Node, step PathStep) []*Node {
	if step.IsIndex {
		if node.Kind != KindArray || step.Index < 0 || step.Index >= len(node.Elems) {
			return nil
		}
		return []*Node{node.Elems[step.Index]}
	}
	if node.Kind != KindObject {
		return nil
	}
	if step.Occurrence == AllOccurrences {
		var out []*Node
		for _, member := range node.Members {
			if member.Key == step.Field {
				out = append(out, member.Value)
			}
		}
		return out
	}
	if step.Occurrence < 1 {
		return nil
	}
	seen := 0
	for _, member := range node.Members {
		if member.Key != step.Field {
			continue
		}
		seen++
		if seen == step.Occurrence {
			return []*Node{member.Value}
		}
	}
	return nil
}

// MemberAt returns the member at the given 0-based object position, preserving
// duplicate-key order. It returns false when n is out of range.
func (n *Node) MemberAt(pos int) (Member, bool) {
	if n.Kind != KindObject || pos < 0 || pos >= len(n.Members) {
		return Member{}, false
	}
	return n.Members[pos], true
}

// Len returns the number of object members or array elements.
func (n *Node) Len() int {
	switch n.Kind {
	case KindObject:
		return len(n.Members)
	case KindArray:
		return len(n.Elems)
	default:
		return 0
	}
}
