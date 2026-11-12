package dataeng

import "fmt"

// SegmentKind is the explicit type of a single path segment.
type SegmentKind int

const (
	// Name selects an object field. The segment's Name field is used.
	Name SegmentKind = iota + 1
	// Index selects an array element. The segment's Index field is used and
	// must be non-negative.
	Index
)

// Segment is one explicit step of a flat field path. A segment is either an
// object field name or a non-negative array index.
type Segment struct {
	Kind  SegmentKind
	Name  string
	Index int
}

// NameSegment builds an object-field path segment.
func NameSegment(name string) Segment {
	return Segment{Kind: Name, Name: name}
}

// IndexSegment builds a non-negative array-index path segment.
func IndexSegment(index int) Segment {
	return Segment{Kind: Index, Index: index}
}

// Kind identifies the concrete role of an output Node.
type Kind int

const (
	// Missing marks an array hole. A missing node is never null: it carries no
	// value and no origins.
	Missing Kind = iota
	// Object holds named fields.
	Object
	// Array holds indexed elements, possibly sparse.
	Array
	// Leaf holds a scalar value.
	Leaf
)

// ObjectField is one name/node pair of an Object node. Fields are returned in
// UTF-8 byte order of their names.
type ObjectField struct {
	Name string
	Node *Node
}

// Node is the materialized nested structure. Exactly one role is active
// depending on Kind:
//
//   - Object: Fields, sorted by name in UTF-8 byte order;
//   - Array:  Elems, whose length is maxIndex+1 and whose holes are MissingNode;
//   - Leaf:   Value and Origins (every source field ordinal that produced it);
//   - Missing: an array hole, all other fields are empty.
type Node struct {
	Kind    Kind
	Fields  []ObjectField
	Elems   []*Node
	Value   any
	Origins []int
}

// MissingNode is the shared marker returned for every sparse-array hole.
var MissingNode = &Node{Kind: Missing}

// IsMissing reports whether n is nil or a missing-array-hole marker.
func (n *Node) IsMissing() bool {
	return n == nil || n.Kind == Missing
}

// Field is one flat input record field. Path is the explicit segment path; an
// empty Path means the value is the whole root. Ordinal is the field's
// original sequence number and must be non-negative.
type Field struct {
	Path    []Segment
	Value   any
	Ordinal int
}

// Limits bounds sparse-array expansion so that a hostile index can never force
// a giant allocation.
//
// MaxArrayIndex is the largest permitted index, inclusive. A value of -1 means
// no index cap; 0 means only index 0 is permitted (zero is a real limit, not
// "unset"). MaxCells caps the total number of expanded array cells across all
// array nodes, counting each array as maxIndex+1; a value <= 0 means no cell
// cap. Use UnlimitedLimits to obtain the no-limit configuration.
type Limits struct {
	MaxArrayIndex int
	MaxCells      int
}

// UnlimitedLimits returns limits that impose neither an index nor a cell cap.
func UnlimitedLimits() Limits {
	return Limits{MaxArrayIndex: -1}
}

func (l Limits) valid() error {
	if l.MaxArrayIndex < -1 {
		return conflict(ReasonInvalidInput, nil, -1,
			fmt.Sprintf("Limits.MaxArrayIndex must be >= -1, got %d", l.MaxArrayIndex))
	}
	if l.MaxCells < 0 {
		return conflict(ReasonInvalidInput, nil, -1,
			fmt.Sprintf("Limits.MaxCells must be >= 0, got %d", l.MaxCells))
	}
	return nil
}
