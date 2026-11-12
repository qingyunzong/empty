package dataeng

import (
	"fmt"
	"math"
	"reflect"
	"sort"
)

// bnode is the sparse in-progress tree. Arrays keep a map plus maxIdx rather
// than a slice, so no backing array is ever sized by an untrusted index.
type bnode struct {
	kind     Kind
	fields   map[string]*bnode
	elems    map[int]*bnode
	maxIdx   int
	cells    int64
	value    any
	assigned bool
	origins  []int
}

type builder struct {
	root   *bnode
	limits Limits
	cells  int64
}

// Build restores the nested object/array tree for one record. On any conflict
// or budget violation the whole record is rejected: a non-nil error is
// returned together with a nil tree. An empty field list yields (nil, nil).
func Build(fields []Field, limits Limits) (*Node, error) {
	if err := limits.valid(); err != nil {
		return nil, err
	}
	b := &builder{limits: limits}
	for _, field := range fields {
		if field.Ordinal < 0 {
			return nil, conflict(ReasonInvalidInput, field.Path, field.Ordinal,
				fmt.Sprintf("ordinal must be non-negative, got %d", field.Ordinal))
		}
		if err := b.insert(field); err != nil {
			return nil, err
		}
	}
	if b.root == nil {
		return nil, nil
	}
	return b.materialize(b.root)
}

func (b *builder) insert(field Field) error {
	for _, seg := range field.Path {
		switch seg.Kind {
		case Name:
		case Index:
			if seg.Index < 0 {
				return conflict(ReasonInvalidInput, field.Path, field.Ordinal,
					fmt.Sprintf("array index must be non-negative, got %d", seg.Index))
			}
		default:
			return conflict(ReasonInvalidInput, field.Path, field.Ordinal,
				fmt.Sprintf("unknown segment kind %d", seg.Kind))
		}
	}
	if err := validateValue(field.Value); err != nil {
		return conflict(ReasonInvalidInput, field.Path, field.Ordinal, err.Error())
	}

	if len(field.Path) == 0 {
		return b.insertRootValue(field)
	}

	first := field.Path[0]
	rootKind := Object
	if first.Kind == Index {
		rootKind = Array
	}
	if b.root == nil {
		b.root = newBuilderNode(rootKind)
	} else if b.root.kind != rootKind {
		return conflict(ReasonTypeConflict, field.Path[:1], field.Ordinal,
			fmt.Sprintf("root is %s but path requires %s", kindName(b.root.kind), kindName(rootKind)))
	}

	cur := b.root
	for i, seg := range field.Path {
		last := i == len(field.Path)-1
		childKind := Leaf
		if !last {
			if field.Path[i+1].Kind == Name {
				childKind = Object
			} else {
				childKind = Array
			}
		}
		child, err := b.descend(cur, seg, childKind, field.Path[:i+1], field.Ordinal)
		if err != nil {
			return err
		}
		cur = child
	}

	if cur.assigned && !reflect.DeepEqual(cur.value, field.Value) {
		return conflict(ReasonValueMismatch, field.Path, field.Ordinal,
			fmt.Sprintf("existing value %#v differs from %#v", cur.value, field.Value))
	}
	cur.value = field.Value
	cur.assigned = true
	cur.origins = insertOrdinal(cur.origins, field.Ordinal)
	return nil
}

func (b *builder) insertRootValue(field Field) error {
	if b.root == nil {
		b.root = &bnode{kind: Leaf, value: field.Value, assigned: true, origins: []int{field.Ordinal}}
		return nil
	}
	if b.root.kind != Leaf {
		return conflict(ReasonTypeConflict, nil, field.Ordinal,
			fmt.Sprintf("root value conflicts with existing %s node", kindName(b.root.kind)))
	}
	if !reflect.DeepEqual(b.root.value, field.Value) {
		return conflict(ReasonValueMismatch, nil, field.Ordinal,
			fmt.Sprintf("root value %#v differs from %#v", b.root.value, field.Value))
	}
	b.root.origins = insertOrdinal(b.root.origins, field.Ordinal)
	return nil
}

// descend moves one segment down from cur, creating the child when absent. It
// enforces container kind agreement, the index cap and the cell budget before
// anything is stored.
func (b *builder) descend(cur *bnode, seg Segment, childKind Kind, pathPrefix []Segment, ordinal int) (*bnode, error) {
	switch seg.Kind {
	case Name:
		if cur.kind != Object {
			return nil, conflict(ReasonTypeConflict, pathPrefix, ordinal,
				fmt.Sprintf("field %q cannot be added under %s node", seg.Name, kindName(cur.kind)))
		}
		if cur.fields == nil {
			cur.fields = make(map[string]*bnode)
		}
		child := cur.fields[seg.Name]
		if child == nil {
			child = newBuilderNode(childKind)
			cur.fields[seg.Name] = child
		} else if child.kind != childKind {
			return nil, conflict(ReasonTypeConflict, pathPrefix, ordinal,
				fmt.Sprintf("position already holds %s, cannot use it as %s",
					kindName(child.kind), kindName(childKind)))
		}
		return child, nil

	case Index:
		if cur.kind != Array {
			return nil, conflict(ReasonTypeConflict, pathPrefix, ordinal,
				fmt.Sprintf("index [%d] cannot be added under %s node", seg.Index, kindName(cur.kind)))
		}
		if cur.elems == nil {
			cur.elems = make(map[int]*bnode)
		}
		child := cur.elems[seg.Index]
		if child == nil {
			// This array alone needs seg.Index+1 expanded cells. Compare
			// against the budget remaining for all arrays (global budget minus
			// cells already consumed by other arrays) before any arithmetic,
			// so an index near MaxInt cannot wrap around the counter.
			if b.limits.MaxCells > 0 {
				remaining := int64(b.limits.MaxCells) - (b.cells - cur.cells)
				if int64(seg.Index)+1 > remaining {
					return nil, conflict(ReasonCellBudget, pathPrefix, ordinal,
						fmt.Sprintf("expanding array to %d cells would exceed MaxCells %d (%d cells already used)",
							int64(seg.Index)+1, b.limits.MaxCells, b.cells))
				}
			}
			if b.limits.MaxArrayIndex >= 0 && seg.Index > b.limits.MaxArrayIndex {
				return nil, conflict(ReasonIndexTooLarge, pathPrefix, ordinal,
					fmt.Sprintf("index %d exceeds MaxArrayIndex %d", seg.Index, b.limits.MaxArrayIndex))
			}
			// Expanded cells of this array grow from maxIdx+1 to seg.Index+1.
			delta := int64(seg.Index - cur.maxIdx)
			if seg.Index >= math.MaxInt32 {
				return nil, conflict(ReasonIndexTooLarge, pathPrefix, ordinal,
					fmt.Sprintf("index %d is too large to represent safely", seg.Index))
			}
			child = newBuilderNode(childKind)
			cur.elems[seg.Index] = child
			b.cells += delta
			cur.cells += delta
			cur.maxIdx = seg.Index
		} else if child.kind != childKind {
			return nil, conflict(ReasonTypeConflict, pathPrefix, ordinal,
				fmt.Sprintf("position already holds %s, cannot use it as %s",
					kindName(child.kind), kindName(childKind)))
		}
		return child, nil

	default:
		return nil, conflict(ReasonInvalidInput, pathPrefix, ordinal,
			fmt.Sprintf("unknown segment kind %d", seg.Kind))
	}
}

func newBuilderNode(kind Kind) *bnode {
	n := &bnode{kind: kind}
	if kind == Array {
		n.maxIdx = -1
	}
	return n
}

// insertOrdinal inserts ordinal while keeping origins sorted. Duplicate
// ordinals are preserved because they represent distinct source fields.
func insertOrdinal(origins []int, ordinal int) []int {
	pos := sort.SearchInts(origins, ordinal)
	origins = append(origins, 0)
	copy(origins[pos+1:], origins[pos:])
	origins[pos] = ordinal
	return origins
}

func (b *builder) materialize(n *bnode) (*Node, error) {
	switch n.kind {
	case Leaf:
		return &Node{
			Kind:    Leaf,
			Value:   n.value,
			Origins: append([]int(nil), n.origins...),
		}, nil

	case Object:
		names := make([]string, 0, len(n.fields))
		for name := range n.fields {
			names = append(names, name)
		}
		// Go string ordering is raw UTF-8 byte ordering.
		sort.Strings(names)
		out := &Node{Kind: Object, Fields: make([]ObjectField, 0, len(names))}
		for _, name := range names {
			child, err := b.materialize(n.fields[name])
			if err != nil {
				return nil, err
			}
			out.Fields = append(out.Fields, ObjectField{Name: name, Node: child})
		}
		return out, nil

	case Array:
		// Defensive guard against overflows on pathological platforms or
		// limits. All normal oversized indices are already rejected upstream.
		if n.maxIdx >= math.MaxInt32 {
			return nil, conflict(ReasonIndexTooLarge, nil, -1,
				fmt.Sprintf("array max index %d is too large to materialize safely", n.maxIdx))
		}
		length := n.maxIdx + 1
		out := &Node{Kind: Array, Elems: make([]*Node, length)}
		for idx := range out.Elems {
			child, ok := n.elems[idx]
			if !ok {
				out.Elems[idx] = MissingNode
				continue
			}
			mat, err := b.materialize(child)
			if err != nil {
				return nil, err
			}
			out.Elems[idx] = mat
		}
		return out, nil

	default:
		return nil, conflict(ReasonInvalidInput, nil, -1,
			fmt.Sprintf("cannot materialize internal node of kind %s", kindName(n.kind)))
	}
}
