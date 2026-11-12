package dataeng_test

import (
	"fmt"
	"reflect"
	"sort"

	dataeng "example.org/dataeng/q0094"
)

// This file contains an independent, deliberately small per-path tree model.
// Every input field is replayed one at a time through refTree; each add either
// merges an equal re-submission or rejects the whole record. Its materialized
// output is then compared structurally with the package under test.

type refKind int

const (
	refMissing refKind = iota
	refObject
	refArray
	refLeaf
)

type refNode struct {
	kind    refKind
	fields  map[string]*refNode
	elems   map[int]*refNode
	maxIdx  int
	cells   int64
	value   any
	origins []int
}

type refError struct {
	reason  dataeng.ConflictReason
	message string
}

func (e *refError) Error() string { return e.message }

type refTree struct {
	root   *refNode
	cells  int64
	limits dataeng.Limits
}

func newRefTree(limits dataeng.Limits) *refTree {
	return &refTree{limits: limits}
}

func refConflict(reason dataeng.ConflictReason, format string, args ...any) error {
	return &refError{reason: reason, message: fmt.Sprintf(format, args...)}
}

func refScalar(v any) bool {
	if v == nil {
		return true
	}
	switch reflect.TypeOf(v).Kind() {
	case reflect.Bool, reflect.String,
		reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr,
		reflect.Float32, reflect.Float64:
		return true
	default:
		return false
	}
}

func (t *refTree) add(f dataeng.Field) error {
	if f.Ordinal < 0 {
		return refConflict(dataeng.ReasonInvalidInput, "negative ordinal")
	}
	for _, seg := range f.Path {
		switch seg.Kind {
		case dataeng.Name:
		case dataeng.Index:
			if seg.Index < 0 {
				return refConflict(dataeng.ReasonInvalidInput, "negative index")
			}
		default:
			return refConflict(dataeng.ReasonInvalidInput, "bad segment kind")
		}
	}
	if !refScalar(f.Value) {
		return refConflict(dataeng.ReasonInvalidInput, "bad value")
	}

	if len(f.Path) == 0 {
		return t.addRoot(f)
	}

	rootKind := refObject
	if f.Path[0].Kind == dataeng.Index {
		rootKind = refArray
	}
	if t.root == nil {
		t.root = &refNode{kind: rootKind}
		if rootKind == refArray {
			t.root.maxIdx = -1
		}
	} else if t.root.kind != rootKind {
		return refConflict(dataeng.ReasonTypeConflict, "root kind mismatch")
	}

	cur := t.root
	for i, seg := range f.Path {
		last := i == len(f.Path)-1
		want := refLeaf
		if !last {
			if f.Path[i+1].Kind == dataeng.Name {
				want = refObject
			} else {
				want = refArray
			}
		}
		next, err := t.step(cur, seg, want)
		if err != nil {
			return err
		}
		cur = next
	}

	if cur.kind != refLeaf {
		return refConflict(dataeng.ReasonTypeConflict, "container used as value")
	}
	if len(cur.origins) > 0 && !reflect.DeepEqual(cur.value, f.Value) {
		return refConflict(dataeng.ReasonValueMismatch, "value mismatch")
	}
	cur.value = f.Value
	cur.origins = append(cur.origins, f.Ordinal)
	sort.Ints(cur.origins)
	return nil
}

func (t *refTree) addRoot(f dataeng.Field) error {
	if t.root == nil {
		t.root = &refNode{kind: refLeaf, value: f.Value, origins: []int{f.Ordinal}}
		return nil
	}
	if t.root.kind != refLeaf {
		return refConflict(dataeng.ReasonTypeConflict, "root container conflict")
	}
	if !reflect.DeepEqual(t.root.value, f.Value) {
		return refConflict(dataeng.ReasonValueMismatch, "root value mismatch")
	}
	t.root.origins = append(t.root.origins, f.Ordinal)
	sort.Ints(t.root.origins)
	return nil
}

func (t *refTree) step(cur *refNode, seg dataeng.Segment, want refKind) (*refNode, error) {
	if seg.Kind == dataeng.Name {
		if cur.kind != refObject {
			return nil, refConflict(dataeng.ReasonTypeConflict, "name under non-object")
		}
		if cur.fields == nil {
			cur.fields = make(map[string]*refNode)
		}
		child := cur.fields[seg.Name]
		if child == nil {
			child = &refNode{kind: want}
			if want == refArray {
				child.maxIdx = -1
			}
			cur.fields[seg.Name] = child
		} else if child.kind != want {
			return nil, refConflict(dataeng.ReasonTypeConflict, "object/array/value clash")
		}
		return child, nil
	}

	if cur.kind != refArray {
		return nil, refConflict(dataeng.ReasonTypeConflict, "index under non-array")
	}
	if cur.elems == nil {
		cur.elems = make(map[int]*refNode)
	}
	child := cur.elems[seg.Index]
	if child == nil {
		if t.limits.MaxCells > 0 {
			remaining := int64(t.limits.MaxCells) - (t.cells - cur.cells)
			if int64(seg.Index)+1 > remaining {
				return nil, refConflict(dataeng.ReasonCellBudget, "cell budget")
			}
		}
		if t.limits.MaxArrayIndex >= 0 && seg.Index > t.limits.MaxArrayIndex {
			return nil, refConflict(dataeng.ReasonIndexTooLarge, "index cap")
		}
		if seg.Index >= maxSafeIndex {
			return nil, refConflict(dataeng.ReasonIndexTooLarge, "unsafe index")
		}
		child = &refNode{kind: want}
		if want == refArray {
			child.maxIdx = -1
		}
		cur.elems[seg.Index] = child
		t.cells += int64(seg.Index - cur.maxIdx)
		cur.cells += int64(seg.Index - cur.maxIdx)
		cur.maxIdx = seg.Index
	} else if child.kind != want {
		return nil, refConflict(dataeng.ReasonTypeConflict, "object/array/value clash")
	}
	return child, nil
}
