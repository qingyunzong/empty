package dataeng

import (
	"errors"
	"fmt"
)

// Kind identifies the data type carried by a schema node.
type Kind int

const (
	KindInt64 Kind = iota
	KindDecimal
	KindString
	KindStruct
	KindList
)

// String returns a compact textual representation of the node kind.
func (k Kind) String() string {
	switch k {
	case KindInt64:
		return "int64"
	case KindDecimal:
		return "decimal"
	case KindString:
		return "string"
	case KindStruct:
		return "struct"
	case KindList:
		return "list"
	default:
		return "unknown"
	}
}

// Node is one vertex of a schema tree. IDs are stable positive integers that
// identify the same logical field across schema versions.
type Node struct {
	ID       int64
	Name     string
	Nullable bool
	Type     Kind
	// Precision and Scale are meaningful only for decimal nodes.
	Precision int
	Scale     int
	Children  []*Node
}

// Schema is a rooted tree of nodes whose IDs are unique within the tree.
type Schema struct {
	Root *Node
}

// Plan records, for every input node ID, the ID of the corresponding node in
// the unified schema. Node IDs are stable across versions, so every mapping is
// an identity mapping; the maps still enumerate the full field correspondence.
type Plan struct {
	OldIDToUnified map[int64]int64
	NewIDToUnified map[int64]int64
}

var (
	// ErrInvalidSchema is returned when an input schema violates the tree or
	// decimal precision invariants, or when the precision limit itself is
	// non-positive.
	ErrInvalidSchema = errors.New("invalid schema")
	// ErrIncompatible is returned when two same-ID nodes cannot be merged.
	ErrIncompatible = errors.New("incompatible schemas")
)

type index struct {
	nodes  map[int64]*Node
	parent map[int64]int64
	rootID int64
}

func buildIndex(s *Schema) (*index, error) {
	if s == nil || s.Root == nil {
		return nil, fmt.Errorf("%w: schema has no root node", ErrInvalidSchema)
	}
	idx := &index{
		nodes:  make(map[int64]*Node),
		parent: make(map[int64]int64),
	}
	var walk func(node *Node, parentID int64) error
	walk = func(node *Node, parentID int64) error {
		if node == nil {
			return fmt.Errorf("%w: nil node under parent %d", ErrInvalidSchema, parentID)
		}
		if node.ID <= 0 {
			return fmt.Errorf("%w: node id must be positive, got %d", ErrInvalidSchema, node.ID)
		}
		if _, exists := idx.nodes[node.ID]; exists {
			return fmt.Errorf("%w: duplicate node id %d", ErrInvalidSchema, node.ID)
		}
		if node.Name == "" {
			return fmt.Errorf("%w: node %d has an empty name", ErrInvalidSchema, node.ID)
		}
		switch node.Type {
		case KindInt64, KindString:
			if len(node.Children) != 0 {
				return fmt.Errorf("%w: %s node %d must have no children", ErrInvalidSchema, node.Type, node.ID)
			}
		case KindDecimal:
			if node.Precision < 1 || node.Scale < 0 || node.Scale > node.Precision {
				return fmt.Errorf("%w: node %d has invalid decimal(%d,%d)", ErrInvalidSchema, node.ID, node.Precision, node.Scale)
			}
			if len(node.Children) != 0 {
				return fmt.Errorf("%w: decimal node %d must have no children", ErrInvalidSchema, node.ID)
			}
		case KindStruct:
			names := make(map[string]struct{}, len(node.Children))
			for _, child := range node.Children {
				if child == nil {
					return fmt.Errorf("%w: struct node %d has a nil child", ErrInvalidSchema, node.ID)
				}
				if _, dup := names[child.Name]; dup {
					return fmt.Errorf("%w: struct node %d has duplicate child name %q", ErrInvalidSchema, node.ID, child.Name)
				}
				names[child.Name] = struct{}{}
			}
		case KindList:
			if len(node.Children) != 1 {
				return fmt.Errorf("%w: list node %d must have exactly one element node, got %d", ErrInvalidSchema, node.ID, len(node.Children))
			}
		default:
			return fmt.Errorf("%w: node %d has unknown type %d", ErrInvalidSchema, node.ID, node.Type)
		}
		idx.nodes[node.ID] = node
		idx.parent[node.ID] = parentID
		for _, child := range node.Children {
			if err := walk(child, node.ID); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(s.Root, 0); err != nil {
		return nil, err
	}
	idx.rootID = s.Root.ID
	return idx, nil
}

// Validate checks that s is a well-formed schema tree and that no decimal
// node declares more precision than maxPrecision.
func Validate(s *Schema, maxPrecision int) error {
	if maxPrecision < 1 {
		return fmt.Errorf("%w: precision limit must be positive, got %d", ErrInvalidSchema, maxPrecision)
	}
	idx, err := buildIndex(s)
	if err != nil {
		return err
	}
	for id, node := range idx.nodes {
		if node.Type == KindDecimal && node.Precision > maxPrecision {
			return fmt.Errorf("%w: decimal node %d precision %d exceeds limit %d", ErrInvalidSchema, id, node.Precision, maxPrecision)
		}
	}
	return nil
}

// Merge unifies two schema versions. The returned schema is built from fresh
// node copies; neither input schema is modified. On failure the error wraps
// ErrInvalidSchema or ErrIncompatible and the returned pointers are nil.
func Merge(oldSchema, newSchema *Schema, maxPrecision int) (*Schema, *Plan, error) {
	if err := Validate(oldSchema, maxPrecision); err != nil {
		return nil, nil, err
	}
	if err := Validate(newSchema, maxPrecision); err != nil {
		return nil, nil, err
	}
	oldIdx, _ := buildIndex(oldSchema)
	newIdx, _ := buildIndex(newSchema)

	if oldIdx.rootID != newIdx.rootID {
		return nil, nil, fmt.Errorf("%w: root id differs: %d vs %d", ErrIncompatible, oldIdx.rootID, newIdx.rootID)
	}
	for id, oldParent := range oldIdx.parent {
		if newParent, ok := newIdx.parent[id]; ok && oldParent != newParent {
			return nil, nil, fmt.Errorf("%w: node %d moved from parent %d to parent %d", ErrIncompatible, id, oldParent, newParent)
		}
	}

	root, err := mergeNode(oldSchema.Root, newSchema.Root, oldIdx, newIdx, maxPrecision)
	if err != nil {
		return nil, nil, err
	}

	plan := &Plan{
		OldIDToUnified: make(map[int64]int64, len(oldIdx.nodes)),
		NewIDToUnified: make(map[int64]int64, len(newIdx.nodes)),
	}
	for id := range oldIdx.nodes {
		plan.OldIDToUnified[id] = id
	}
	for id := range newIdx.nodes {
		plan.NewIDToUnified[id] = id
	}
	return &Schema{Root: root}, plan, nil
}

func cloneNode(node *Node, forceNullable bool) *Node {
	clone := &Node{
		ID:        node.ID,
		Name:      node.Name,
		Nullable:  node.Nullable || forceNullable,
		Type:      node.Type,
		Precision: node.Precision,
		Scale:     node.Scale,
	}
	for _, child := range node.Children {
		clone.Children = append(clone.Children, cloneNode(child, false))
	}
	return clone
}

func mergeNode(oldNode, newNode *Node, oldIdx, newIdx *index, maxPrecision int) (*Node, error) {
	switch {
	case oldNode == nil:
		return cloneNode(newNode, true), nil
	case newNode == nil:
		return cloneNode(oldNode, true), nil
	}

	merged := &Node{
		ID:       oldNode.ID,
		Name:     newNode.Name,
		Nullable: oldNode.Nullable || newNode.Nullable,
	}

	if oldNode.Type != newNode.Type {
		if !(oldNode.Type == KindInt64 && newNode.Type == KindDecimal) &&
			!(oldNode.Type == KindDecimal && newNode.Type == KindInt64) {
			return nil, fmt.Errorf("%w: node %d changed type from %s to %s", ErrIncompatible, oldNode.ID, oldNode.Type, newNode.Type)
		}
	}

	switch {
	case oldNode.Type == KindStruct || newNode.Type == KindStruct:
		if oldNode.Type != KindStruct || newNode.Type != KindStruct {
			return nil, fmt.Errorf("%w: node %d changed type from %s to %s", ErrIncompatible, oldNode.ID, oldNode.Type, newNode.Type)
		}
		merged.Type = KindStruct
		children, err := mergeStructChildren(oldNode, newNode, oldIdx, newIdx, maxPrecision)
		if err != nil {
			return nil, err
		}
		merged.Children = children
	case oldNode.Type == KindList || newNode.Type == KindList:
		if oldNode.Type != KindList || newNode.Type != KindList {
			return nil, fmt.Errorf("%w: node %d changed type from %s to %s", ErrIncompatible, oldNode.ID, oldNode.Type, newNode.Type)
		}
		merged.Type = KindList
		if oldNode.Children[0].ID != newNode.Children[0].ID {
			return nil, fmt.Errorf("%w: list node %d element id changed from %d to %d", ErrIncompatible, oldNode.ID, oldNode.Children[0].ID, newNode.Children[0].ID)
		}
		element, err := mergeNode(oldNode.Children[0], newNode.Children[0], oldIdx, newIdx, maxPrecision)
		if err != nil {
			return nil, err
		}
		merged.Children = []*Node{element}
	default:
		if err := mergeLeaf(merged, oldNode, newNode, maxPrecision); err != nil {
			return nil, err
		}
	}
	return merged, nil
}

func mergeStructChildren(oldNode, newNode *Node, oldIdx, newIdx *index, maxPrecision int) ([]*Node, error) {
	newByID := make(map[int64]*Node, len(newNode.Children))
	for _, child := range newNode.Children {
		newByID[child.ID] = child
	}
	oldByID := make(map[int64]*Node, len(oldNode.Children))
	for _, child := range oldNode.Children {
		oldByID[child.ID] = child
	}

	merged := make([]*Node, 0, len(oldNode.Children)+len(newNode.Children))
	names := make(map[string]struct{}, cap(merged))

	for _, oldChild := range oldNode.Children {
		child, err := mergeNode(oldChild, newByID[oldChild.ID], oldIdx, newIdx, maxPrecision)
		if err != nil {
			return nil, err
		}
		if _, dup := names[child.Name]; dup {
			return nil, fmt.Errorf("%w: rename makes child name %q duplicate under node %d", ErrIncompatible, child.Name, oldNode.ID)
		}
		names[child.Name] = struct{}{}
		merged = append(merged, child)
	}
	for _, newChild := range newNode.Children {
		if _, exists := oldByID[newChild.ID]; exists {
			continue
		}
		child, err := mergeNode(nil, newChild, oldIdx, newIdx, maxPrecision)
		if err != nil {
			return nil, err
		}
		if _, dup := names[child.Name]; dup {
			return nil, fmt.Errorf("%w: new child name %q duplicates an existing name under node %d", ErrIncompatible, child.Name, oldNode.ID)
		}
		names[child.Name] = struct{}{}
		merged = append(merged, child)
	}
	return merged, nil
}

func mergeLeaf(merged, oldNode, newNode *Node, maxPrecision int) error {
	oldDecimal := decimalView(oldNode)
	newDecimal := decimalView(newNode)
	if oldDecimal == nil || newDecimal == nil {
		if oldNode.Type != newNode.Type {
			return fmt.Errorf("%w: node %d changed type from %s to %s", ErrIncompatible, oldNode.ID, oldNode.Type, newNode.Type)
		}
		merged.Type = oldNode.Type
		return nil
	}

	merged.Type = KindDecimal
	merged.Scale = max(oldDecimal.Scale, newDecimal.Scale)
	oldIntDigits := oldDecimal.Precision - oldDecimal.Scale
	newIntDigits := newDecimal.Precision - newDecimal.Scale
	merged.Precision = merged.Scale + max(oldIntDigits, newIntDigits)
	if merged.Precision > maxPrecision {
		return fmt.Errorf("%w: merged decimal node %d precision %d exceeds limit %d", ErrIncompatible, oldNode.ID, merged.Precision, maxPrecision)
	}
	return nil
}

// decimalView returns the effective decimal(p,s) shape of a leaf node,
// promoting int64 to decimal(19,0). Non-decimal, non-int64 types yield nil.
func decimalView(node *Node) *Node {
	switch node.Type {
	case KindDecimal:
		return node
	case KindInt64:
		return &Node{Type: KindDecimal, Precision: 19, Scale: 0}
	default:
		return nil
	}
}
