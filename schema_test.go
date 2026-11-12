package dataeng

import (
	"errors"
	"testing"
)

func leaf(id int64, name string, kind Kind) *Node {
	return &Node{ID: id, Name: name, Type: kind}
}

func decimalNode(id int64, name string, precision, scale int) *Node {
	return &Node{ID: id, Name: name, Type: KindDecimal, Precision: precision, Scale: scale}
}

func findNode(root *Node, id int64) *Node {
	if root.ID == id {
		return root
	}
	for _, child := range root.Children {
		if found := findNode(child, id); found != nil {
			return found
		}
	}
	return nil
}

func assertErrIs(t *testing.T, err error, target error) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error wrapping %v, got nil", target)
	}
	if !errors.Is(err, target) {
		t.Fatalf("expected error wrapping %v, got %v", target, err)
	}
}

func TestMergeRename(t *testing.T) {
	old := &Schema{Root: &Node{
		ID:   1,
		Name: "row",
		Type: KindStruct,
		Children: []*Node{
			leaf(2, "old_name", KindString),
		},
	}}
	newSchema := &Schema{Root: &Node{
		ID:   1,
		Name: "row",
		Type: KindStruct,
		Children: []*Node{
			leaf(2, "new_name", KindString),
		},
	}}

	merged, plan, err := Merge(old, newSchema, 38)
	if err != nil {
		t.Fatalf("merge failed: %v", err)
	}
	field := findNode(merged.Root, 2)
	if field.Name != "new_name" {
		t.Fatalf("expected renamed field, got %q", field.Name)
	}
	if plan.OldIDToUnified[2] != 2 || plan.NewIDToUnified[2] != 2 {
		t.Fatalf("expected identity mapping, got %+v", plan)
	}
	if old.Root.Children[0].Name != "old_name" {
		t.Fatal("merge mutated the input schema")
	}
}

func TestMergeRenameCollision(t *testing.T) {
	old := &Schema{Root: &Node{
		ID:   1,
		Name: "row",
		Type: KindStruct,
		Children: []*Node{
			leaf(2, "a", KindString),
			leaf(3, "b", KindString),
		},
	}}

	dupInput := &Schema{Root: &Node{
		ID:   1,
		Name: "row",
		Type: KindStruct,
		Children: []*Node{
			leaf(2, "b", KindString),
			leaf(3, "b", KindString),
		},
	}}
	assertErrIs(t, Validate(dupInput, 38), ErrInvalidSchema)

	newSchema := &Schema{Root: &Node{
		ID:   1,
		Name: "row",
		Type: KindStruct,
		Children: []*Node{
			leaf(2, "b", KindString),
		},
	}}
	_, _, err := Merge(old, newSchema, 38)
	assertErrIs(t, err, ErrIncompatible)
}

func TestMergeNestedAddition(t *testing.T) {
	old := &Schema{Root: &Node{
		ID:   1,
		Name: "row",
		Type: KindStruct,
		Children: []*Node{
			leaf(2, "kept", KindInt64),
			leaf(3, "dropped", KindString),
		},
	}}
	newSchema := &Schema{Root: &Node{
		ID:   1,
		Name: "row",
		Type: KindStruct,
		Children: []*Node{
			leaf(2, "kept", KindInt64),
			{
				ID:       4,
				Name:     "added",
				Type:     KindStruct,
				Nullable: false,
				Children: []*Node{
					leaf(5, "inner", KindString),
				},
			},
		},
	}}

	merged, plan, err := Merge(old, newSchema, 38)
	if err != nil {
		t.Fatalf("merge failed: %v", err)
	}

	gotOrder := make([]int64, 0, len(merged.Root.Children))
	for _, child := range merged.Root.Children {
		gotOrder = append(gotOrder, child.ID)
	}
	wantOrder := []int64{2, 3, 4}
	if len(gotOrder) != len(wantOrder) {
		t.Fatalf("expected children %v, got %v", wantOrder, gotOrder)
	}
	for i, id := range wantOrder {
		if gotOrder[i] != id {
			t.Fatalf("expected children %v, got %v", wantOrder, gotOrder)
		}
	}

	if !findNode(merged.Root, 3).Nullable {
		t.Error("missing node must become nullable")
	}
	added := findNode(merged.Root, 4)
	if !added.Nullable {
		t.Error("new node must become nullable")
	}
	if inner := findNode(merged.Root, 5); inner.Nullable {
		t.Error("only the added subtree root is forced nullable; descendants keep their own nullability")
	}
	if plan.OldIDToUnified[3] != 3 || plan.NewIDToUnified[4] != 4 || plan.NewIDToUnified[5] != 5 {
		t.Fatalf("unexpected plan: %+v", plan)
	}
}

func TestMergeSameNameDifferentID(t *testing.T) {
	old := &Schema{Root: &Node{
		ID:   1,
		Name: "row",
		Type: KindStruct,
		Children: []*Node{
			{ID: 2, Name: "group", Type: KindStruct, Children: []*Node{
				leaf(3, "x", KindString),
			}},
		},
	}}
	newSchema := &Schema{Root: &Node{
		ID:   1,
		Name: "row",
		Type: KindStruct,
		Children: []*Node{
			{ID: 2, Name: "group", Type: KindStruct, Children: []*Node{
				leaf(4, "x", KindString),
			}},
		},
	}}

	_, _, err := Merge(old, newSchema, 38)
	assertErrIs(t, err, ErrIncompatible)

	old2 := &Schema{Root: &Node{
		ID:   10,
		Name: "row",
		Type: KindStruct,
		Children: []*Node{
			{ID: 11, Name: "left", Type: KindStruct, Children: []*Node{
				leaf(12, "x", KindString),
			}},
		},
	}}
	new2 := &Schema{Root: &Node{
		ID:   10,
		Name: "row",
		Type: KindStruct,
		Children: []*Node{
			{ID: 11, Name: "left", Type: KindStruct, Children: []*Node{
				leaf(12, "x", KindString),
			}},
			{ID: 13, Name: "right", Type: KindStruct, Children: []*Node{
				leaf(14, "x", KindString),
			}},
		},
	}}
	merged, _, err := Merge(old2, new2, 38)
	if err != nil {
		t.Fatalf("same name under different parents should merge: %v", err)
	}
	if findNode(merged.Root, 12) == nil || findNode(merged.Root, 14) == nil {
		t.Fatal("both same-named fields should be present in separate branches")
	}
}

func TestMergePrecisionPromotion(t *testing.T) {
	old := &Schema{Root: &Node{
		ID:       1,
		Name:     "row",
		Type:     KindStruct,
		Children: []*Node{leaf(2, "amount", KindInt64)},
	}}
	newSchema := &Schema{Root: &Node{
		ID:   1,
		Name: "row",
		Type: KindStruct,
		Children: []*Node{
			decimalNode(2, "amount", 12, 2),
		},
	}}

	merged, _, err := Merge(old, newSchema, 38)
	if err != nil {
		t.Fatalf("merge failed: %v", err)
	}
	amount := findNode(merged.Root, 2)
	if amount.Type != KindDecimal || amount.Precision != 21 || amount.Scale != 2 {
		t.Fatalf("expected decimal(21,2) from int64 vs decimal(12,2), got decimal(%d,%d)", amount.Precision, amount.Scale)
	}

	merged, _, err = Merge(newSchema, old, 38)
	if err != nil {
		t.Fatalf("reverse merge failed: %v", err)
	}
	amount = findNode(merged.Root, 2)
	if amount.Type != KindDecimal || amount.Precision != 21 || amount.Scale != 2 {
		t.Fatalf("expected symmetric decimal(21,2), got decimal(%d,%d)", amount.Precision, amount.Scale)
	}

	d1 := &Schema{Root: &Node{ID: 1, Name: "r", Type: KindStruct,
		Children: []*Node{decimalNode(2, "d", 10, 4)}}}
	d2 := &Schema{Root: &Node{ID: 1, Name: "r", Type: KindStruct,
		Children: []*Node{decimalNode(2, "d", 8, 0)}}}
	merged, _, err = Merge(d1, d2, 38)
	if err != nil {
		t.Fatalf("decimal merge failed: %v", err)
	}
	amount = findNode(merged.Root, 2)
	if amount.Precision != 12 || amount.Scale != 4 {
		t.Fatalf("expected decimal(12,4), got decimal(%d,%d)", amount.Precision, amount.Scale)
	}

	_, _, err = Merge(d1, d2, 10)
	assertErrIs(t, err, ErrIncompatible)

	tooBig := &Schema{Root: &Node{ID: 1, Name: "r", Type: KindStruct,
		Children: []*Node{decimalNode(2, "d", 20, 2)}}}
	assertErrIs(t, Validate(tooBig, 10), ErrInvalidSchema)
}

func TestValidationAndStructuralFailures(t *testing.T) {
	badDecimal := &Schema{Root: &Node{ID: 1, Name: "r", Type: KindStruct,
		Children: []*Node{decimalNode(2, "d", 2, 3)}}}
	assertErrIs(t, Validate(badDecimal, 38), ErrInvalidSchema)

	zeroID := &Schema{Root: &Node{ID: 0, Name: "r", Type: KindString}}
	assertErrIs(t, Validate(zeroID, 38), ErrInvalidSchema)

	dupID := &Schema{Root: &Node{ID: 1, Name: "r", Type: KindStruct, Children: []*Node{
		leaf(2, "a", KindString),
		leaf(2, "b", KindString),
	}}}
	assertErrIs(t, Validate(dupID, 38), ErrInvalidSchema)

	badList := &Schema{Root: &Node{ID: 1, Name: "r", Type: KindList}}
	assertErrIs(t, Validate(badList, 38), ErrInvalidSchema)

	assertErrIs(t, Validate(&Schema{Root: leaf(1, "r", KindString)}, 0), ErrInvalidSchema)

	old := &Schema{Root: leaf(1, "r", KindInt64)}
	newSchema := &Schema{Root: leaf(1, "r", KindString)}
	_, _, err := Merge(old, newSchema, 38)
	assertErrIs(t, err, ErrIncompatible)

	differentRoots := &Schema{Root: leaf(9, "r", KindString)}
	_, _, err = Merge(old, differentRoots, 38)
	assertErrIs(t, err, ErrIncompatible)

	movedOld := &Schema{Root: &Node{ID: 1, Name: "r", Type: KindStruct, Children: []*Node{
		{ID: 2, Name: "a", Type: KindStruct, Children: []*Node{leaf(3, "x", KindString)}},
	}}}
	movedNew := &Schema{Root: &Node{ID: 1, Name: "r", Type: KindStruct, Children: []*Node{
		{ID: 2, Name: "a", Type: KindStruct},
		{ID: 4, Name: "b", Type: KindStruct, Children: []*Node{leaf(3, "x", KindString)}},
	}}}
	_, _, err = Merge(movedOld, movedNew, 38)
	assertErrIs(t, err, ErrIncompatible)

	listOld := &Schema{Root: &Node{ID: 1, Name: "r", Type: KindList, Children: []*Node{
		leaf(2, "item", KindString),
	}}}
	listNew := &Schema{Root: &Node{ID: 1, Name: "r", Type: KindList, Children: []*Node{
		leaf(7, "item", KindString),
	}}}
	_, _, err = Merge(listOld, listNew, 38)
	assertErrIs(t, err, ErrIncompatible)
}

func TestMergeKeepsNullabilityUnion(t *testing.T) {
	old := &Schema{Root: &Node{
		ID:       1,
		Name:     "row",
		Type:     KindStruct,
		Nullable: true,
		Children: []*Node{
			{ID: 2, Name: "f", Type: KindString, Nullable: false},
		},
	}}
	newSchema := &Schema{Root: &Node{
		ID:       1,
		Name:     "row",
		Type:     KindStruct,
		Nullable: false,
		Children: []*Node{
			{ID: 2, Name: "f", Type: KindString, Nullable: true},
		},
	}}
	merged, _, err := Merge(old, newSchema, 38)
	if err != nil {
		t.Fatalf("merge failed: %v", err)
	}
	if !merged.Root.Nullable {
		t.Error("root nullability should be the union of both inputs")
	}
	if !findNode(merged.Root, 2).Nullable {
		t.Error("matched field nullability should be the union of both inputs")
	}
}
