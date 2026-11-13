package dataeng

import (
	"reflect"
	"strings"
	"testing"
)

// refTable is an independent table model used only by the tests. It shares no
// code with the parser under test: expectations are built by driving this
// model directly, then compared against the parser output.
type refTable struct {
	order []string
	cells map[string]any
}

func newRefTable() *refTable {
	return &refTable{cells: map[string]any{}}
}

// refSet assigns a dotted key path, creating implicit parent tables. It
// returns false when a basic key is duplicated or an intermediate key is not
// a table.
func (t *refTable) refSet(path []string, value any) bool {
	cur := t
	for i := 0; i < len(path)-1; i++ {
		key := path[i]
		existing, ok := cur.cells[key]
		if !ok {
			child := newRefTable()
			cur.cells[key] = child
			cur.order = append(cur.order, key)
			cur = child
			continue
		}
		child, isTable := existing.(*refTable)
		if !isTable {
			return false
		}
		cur = child
	}
	last := path[len(path)-1]
	if _, exists := cur.cells[last]; exists {
		return false
	}
	cur.cells[last] = value
	cur.order = append(cur.order, last)
	return true
}

// refHeader opens a standard table header, returning the target table or nil
// when the path conflicts with an existing non-table or a redefined table.
func (t *refTable) refHeader(path []string, defined map[string]bool) *refTable {
	if defined[strings.Join(path, ".")] {
		return nil
	}
	cur := t
	for _, key := range path {
		existing, ok := cur.cells[key]
		if !ok {
			child := newRefTable()
			cur.cells[key] = child
			cur.order = append(cur.order, key)
			cur = child
			continue
		}
		child, isTable := existing.(*refTable)
		if !isTable {
			return nil
		}
		cur = child
	}
	defined[strings.Join(path, ".")] = true
	return cur
}

// refArrayHeader appends a new table element for an array-of-table header.
func (t *refTable) refArrayHeader(path []string) *refTable {
	cur := t
	for i, key := range path {
		last := i == len(path)-1
		existing, ok := cur.cells[key]
		if !ok {
			if last {
				child := newRefTable()
				cur.cells[key] = []any{child}
				cur.order = append(cur.order, key)
				return child
			}
			child := newRefTable()
			cur.cells[key] = child
			cur.order = append(cur.order, key)
			cur = child
			continue
		}
		if last {
			arr, isArray := existing.([]any)
			if !isArray {
				return nil
			}
			child := newRefTable()
			cur.cells[key] = append(arr, child)
			return child
		}
		switch node := existing.(type) {
		case *refTable:
			cur = node
		case []any:
			elem, ok := node[len(node)-1].(*refTable)
			if !ok {
				return nil
			}
			cur = elem
		default:
			return nil
		}
	}
	return nil
}

func (t *refTable) snapshot() any {
	out := map[string]any{}
	for _, key := range t.order {
		out[key] = refSnapshot(t.cells[key])
	}
	return out
}

func refSnapshot(v any) any {
	switch x := v.(type) {
	case *refTable:
		return x.snapshot()
	case []any:
		out := make([]any, len(x))
		for i, elem := range x {
			out[i] = refSnapshot(elem)
		}
		return out
	default:
		return v
	}
}

func assertParseMatches(t *testing.T, src string, expected *refTable) {
	t.Helper()
	got, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse returned unexpected error: %v\nsource:\n%s", err, src)
	}
	if !reflect.DeepEqual(got.toMap(), expected.snapshot()) {
		t.Fatalf("Parse mismatch\n got: %#v\nwant: %#v\nsource:\n%s", got.toMap(), expected.snapshot(), src)
	}
}

func assertParseError(t *testing.T, src string) {
	t.Helper()
	got, err := Parse(src)
	if err == nil {
		t.Fatalf("Parse expected error, got %#v\nsource:\n%s", got.toMap(), src)
	}
	var pe *ParseError
	if !asParseError(err, &pe) {
		t.Fatalf("Parse error is not *ParseError: %T", err)
	}
}

func asParseError(err error, target **ParseError) bool {
	pe, ok := err.(*ParseError)
	if !ok {
		return false
	}
	*target = pe
	return true
}
