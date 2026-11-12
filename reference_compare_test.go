package dataeng_test

import (
	"fmt"
	"math"
	"math/rand"
	"reflect"
	"sort"
	"testing"

	dataeng "example.org/dataeng/q0094"
)

const maxSafeIndex = math.MaxInt32

// materializeRef converts the sparse reference tree into the same *Node shape
// produced by the package, including MissingNode holes and byte-ordered fields.
func materializeRef(n *refNode) *dataeng.Node {
	if n == nil {
		return dataeng.MissingNode
	}
	switch n.kind {
	case refLeaf:
		return &dataeng.Node{
			Kind:    dataeng.Leaf,
			Value:   n.value,
			Origins: append([]int(nil), n.origins...),
		}
	case refObject:
		names := make([]string, 0, len(n.fields))
		for name := range n.fields {
			names = append(names, name)
		}
		sort.Strings(names)
		out := &dataeng.Node{Kind: dataeng.Object, Fields: make([]dataeng.ObjectField, 0, len(names))}
		for _, name := range names {
			out.Fields = append(out.Fields, dataeng.ObjectField{Name: name, Node: materializeRef(n.fields[name])})
		}
		return out
	case refArray:
		length := n.maxIdx + 1
		out := &dataeng.Node{Kind: dataeng.Array, Elems: make([]*dataeng.Node, length)}
		for idx := range out.Elems {
			child, ok := n.elems[idx]
			if !ok {
				out.Elems[idx] = dataeng.MissingNode
				continue
			}
			out.Elems[idx] = materializeRef(child)
		}
		return out
	default:
		return dataeng.MissingNode
	}
}

func assertNodesEqual(t *testing.T, got, want *dataeng.Node, path string) {
	t.Helper()
	if got == nil || want == nil {
		if got != want {
			t.Fatalf("%s: node nil mismatch got=%v want=%v", path, got, want)
		}
		return
	}
	if got.Kind != want.Kind {
		t.Fatalf("%s: kind got %v want %v", path, got.Kind, want.Kind)
	}
	switch got.Kind {
	case dataeng.Leaf:
		if !reflect.DeepEqual(got.Value, want.Value) {
			t.Fatalf("%s: value got %#v want %#v", path, got.Value, want.Value)
		}
		if !reflect.DeepEqual(got.Origins, want.Origins) {
			t.Fatalf("%s: origins got %v want %v", path, got.Origins, want.Origins)
		}
	case dataeng.Object:
		if len(got.Fields) != len(want.Fields) {
			t.Fatalf("%s: field count got %d want %d", path, len(got.Fields), len(want.Fields))
		}
		for i := range got.Fields {
			if got.Fields[i].Name != want.Fields[i].Name {
				t.Fatalf("%s: field name order got %q want %q", path, got.Fields[i].Name, want.Fields[i].Name)
			}
			assertNodesEqual(t, got.Fields[i].Node, want.Fields[i].Node, path+"."+got.Fields[i].Name)
		}
	case dataeng.Array:
		if len(got.Elems) != len(want.Elems) {
			t.Fatalf("%s: array length got %d want %d", path, len(got.Elems), len(want.Elems))
		}
		for idx := range got.Elems {
			gotMissing := got.Elems[idx] == dataeng.MissingNode
			wantMissing := want.Elems[idx] == dataeng.MissingNode
			if gotMissing != wantMissing {
				t.Fatalf("%s[%d]: missing mismatch got=%v want=%v", path, idx, gotMissing, wantMissing)
			}
			if !gotMissing {
				assertNodesEqual(t, got.Elems[idx], want.Elems[idx], fmt.Sprintf("%s[%d]", path, idx))
			}
		}
	}
}

// TestReferenceReplayTable drives a hand-written record through both models.
func TestReferenceReplayTable(t *testing.T) {
	fields := []dataeng.Field{
		field([]dataeng.Segment{nseg("orders"), iseg(0), nseg("id")}, 100, 0),
		field([]dataeng.Segment{nseg("orders"), iseg(2), nseg("id")}, 102, 1),
		field([]dataeng.Segment{nseg("orders"), iseg(2), nseg("id")}, 102, 7),
		field([]dataeng.Segment{nseg("orders"), iseg(0), nseg("qty")}, 3, 2),
		field([]dataeng.Segment{nseg("meta"), nseg("version")}, "v2", 3),
		field([]dataeng.Segment{nseg("meta"), nseg("version")}, "v2", 5),
		field([]dataeng.Segment{nseg("meta"), nseg("ok")}, true, 4),
	}
	limits := dataeng.Limits{MaxArrayIndex: -1, MaxCells: 16}

	got, err := dataeng.Build(fields, limits)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}

	ref := newRefTree(limits)
	for _, f := range fields {
		if err := ref.add(f); err != nil {
			t.Fatalf("reference add: %v", err)
		}
	}
	want := materializeRef(ref.root)
	assertNodesEqual(t, got, want, "$")

	orders := objectField(got, "orders")
	if orders == nil {
		t.Fatalf("orders array missing")
	}
	leaf := orders.Elems[2]
	if leaf.Kind != dataeng.Object {
		t.Fatalf("orders[2] = %v, want object", leaf.Kind)
	}
	idNode := objectField(leaf, "id")
	if idNode == nil {
		t.Fatalf("orders[2].id missing")
	}
	if !reflect.DeepEqual(idNode.Origins, []int{1, 7}) {
		t.Fatalf("replayed leaf origins = %v", idNode.Origins)
	}
}

// TestReferenceReplayConflicts checks that both models reject identical
// scenarios with the same reason category.
func TestReferenceReplayConflicts(t *testing.T) {
	scenarios := []struct {
		name   string
		fields []dataeng.Field
		reason dataeng.ConflictReason
	}{
		{
			name: "value mismatch",
			fields: []dataeng.Field{
				field([]dataeng.Segment{nseg("a"), nseg("b")}, 1, 0),
				field([]dataeng.Segment{nseg("a"), nseg("b")}, 2, 1),
			},
			reason: dataeng.ReasonValueMismatch,
		},
		{
			name: "type clash",
			fields: []dataeng.Field{
				field([]dataeng.Segment{nseg("a"), iseg(0)}, 1, 0),
				field([]dataeng.Segment{nseg("a"), nseg("b")}, 2, 1),
			},
			reason: dataeng.ReasonTypeConflict,
		},
		{
			name: "index cap",
			fields: []dataeng.Field{
				field([]dataeng.Segment{iseg(5)}, 1, 0),
			},
			reason: dataeng.ReasonIndexTooLarge,
		},
		{
			name: "cell budget",
			fields: []dataeng.Field{
				field([]dataeng.Segment{iseg(4)}, 1, 0),
			},
			reason: dataeng.ReasonCellBudget,
		},
	}
	for _, sc := range scenarios {
		t.Run(sc.name, func(t *testing.T) {
			limits := dataeng.Limits{MaxArrayIndex: 3, MaxCells: 4}
			if sc.reason == dataeng.ReasonIndexTooLarge {
				limits.MaxCells = 0
			}
			if sc.reason == dataeng.ReasonCellBudget {
				limits.MaxArrayIndex = -1
			}
			_, gotErr := dataeng.Build(sc.fields, limits)
			expectReason(t, gotErr, sc.reason)

			ref := newRefTree(limits)
			var refErr error
			for _, f := range sc.fields {
				if err := ref.add(f); err != nil {
					refErr = err
					break
				}
			}
			if refErr == nil {
				t.Fatalf("reference model did not reject %s", sc.name)
			}
			if refErr.(*refError).reason != sc.reason {
				t.Fatalf("reference reason = %q, want %q", refErr.(*refError).reason, sc.reason)
			}
		})
	}
}

// TestReferenceRandomized replays randomized field streams against both models
// and requires identical acceptance decisions and trees.
func TestReferenceRandomized(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	names := []string{"a", "b", "z", "é", "中", "nested"}
	values := []any{nil, true, false, "x", "y", 1, 2, int64(7), 1.5, float32(2.5)}

	for iteration := 0; iteration < 200; iteration++ {
		limits := dataeng.Limits{
			MaxArrayIndex: rng.Intn(8) - 1,
			MaxCells:      1 + rng.Intn(24),
		}
		count := rng.Intn(14)
		fields := make([]dataeng.Field, count)
		usedOrdinals := make(map[int]bool)
		for i := range fields {
			depth := 1 + rng.Intn(3)
			path := make([]dataeng.Segment, depth)
			for d := range path {
				if rng.Intn(2) == 0 {
					path[d] = nseg(names[rng.Intn(len(names))])
				} else {
					path[d] = iseg(rng.Intn(7))
				}
			}
			ordinal := rng.Intn(40)
			for usedOrdinals[ordinal] {
				ordinal = rng.Intn(40)
			}
			usedOrdinals[ordinal] = true
			fields[i] = dataeng.Field{
				Path:    path,
				Value:   values[rng.Intn(len(values))],
				Ordinal: ordinal,
			}
		}

		got, gotErr := dataeng.Build(fields, limits)

		ref := newRefTree(limits)
		var refErr error
		for _, f := range fields {
			if err := ref.add(f); err != nil {
				refErr = err
				break
			}
		}

		if (gotErr == nil) != (refErr == nil) {
			t.Fatalf("iteration %d: decision mismatch package=%v reference=%v fields=%#v",
				iteration, gotErr, refErr, fields)
		}
		if gotErr != nil {
			pkgReason := gotErr.(*dataeng.ConflictError).Reason
			refReason := refErr.(*refError).reason
			if pkgReason != refReason {
				t.Fatalf("iteration %d: reason mismatch package=%s reference=%s fields=%#v",
					iteration, pkgReason, refReason, fields)
			}
			continue
		}
		if ref.root == nil {
			if got != nil {
				t.Fatalf("iteration %d: expected nil root", iteration)
			}
			continue
		}
		assertNodesEqual(t, got, materializeRef(ref.root), fmt.Sprintf("iter%d", iteration))
	}
}
