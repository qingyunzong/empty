package dataeng_test

import (
	"strings"
	"testing"

	dataeng "example.org/dataeng/q0094"
)

func nseg(name string) dataeng.Segment { return dataeng.NameSegment(name) }

func iseg(index int) dataeng.Segment { return dataeng.IndexSegment(index) }

func field(path []dataeng.Segment, value any, ordinal int) dataeng.Field {
	return dataeng.Field{Path: path, Value: value, Ordinal: ordinal}
}

func expectReason(t *testing.T, err error, reason dataeng.ConflictReason) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected conflict %q, got nil", reason)
	}
	conflict, ok := err.(*dataeng.ConflictError)
	if !ok {
		t.Fatalf("expected *ConflictError, got %T: %v", err, err)
	}
	if conflict.Reason != reason {
		t.Fatalf("expected reason %q, got %q (%v)", reason, conflict.Reason, err)
	}
}

func objectField(root *dataeng.Node, name string) *dataeng.Node {
	for i := range root.Fields {
		if root.Fields[i].Name == name {
			return root.Fields[i].Node
		}
	}
	return nil
}

func TestNestedObjectAndArray(t *testing.T) {
	fields := []dataeng.Field{
		field([]dataeng.Segment{nseg("user"), nseg("name")}, "alice", 0),
		field([]dataeng.Segment{nseg("user"), nseg("age")}, 30, 4),
		field([]dataeng.Segment{nseg("user"), nseg("tags"), iseg(0)}, "a", 1),
		field([]dataeng.Segment{nseg("user"), nseg("tags"), iseg(2)}, "c", 2),
		field([]dataeng.Segment{nseg("id")}, 7, 3),
	}
	root, err := dataeng.Build(fields, dataeng.UnlimitedLimits())
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if root.Kind != dataeng.Object {
		t.Fatalf("root kind = %v, want object", root.Kind)
	}
	if got := root.Fields[0].Name; got != "id" || root.Fields[1].Name != "user" {
		t.Fatalf("fields not byte-sorted: %q, %q", root.Fields[0].Name, root.Fields[1].Name)
	}
	id := objectField(root, "id")
	if id.Value != 7 || len(id.Origins) != 1 || id.Origins[0] != 3 {
		t.Fatalf("id leaf wrong: %+v", id)
	}
	user := objectField(root, "user")
	if user.Fields[0].Name != "age" || user.Fields[1].Name != "name" || user.Fields[2].Name != "tags" {
		t.Fatalf("user fields not byte-sorted: %+v", user.Fields)
	}
	tags := objectField(user, "tags")
	if tags.Kind != dataeng.Array || len(tags.Elems) != 3 {
		t.Fatalf("tags array wrong: %+v", tags)
	}
	if !tags.Elems[1].IsMissing() || tags.Elems[1] != dataeng.MissingNode {
		t.Fatalf("hole must be the shared MissingNode marker")
	}
	if tags.Elems[0].Value != "a" || tags.Elems[2].Value != "c" {
		t.Fatalf("array values wrong: %+v", tags.Elems)
	}
	if tags.Elems[1].Value != nil {
		t.Fatalf("missing hole must not carry a value")
	}
}

func TestSamePathEqualValuesMerge(t *testing.T) {
	path := []dataeng.Segment{nseg("a"), iseg(1), nseg("b")}
	fields := []dataeng.Field{
		field(path, "same", 5),
		field(path, "same", 2),
		field(path, "same", 9),
	}
	root, err := dataeng.Build(fields, dataeng.UnlimitedLimits())
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	leaf := objectField(root, "a").Elems[1].Fields[0].Node
	if leaf.Value != "same" {
		t.Fatalf("value = %v", leaf.Value)
	}
	wantOrigins := []int{2, 5, 9}
	if len(leaf.Origins) != len(wantOrigins) {
		t.Fatalf("origins = %v, want %v", leaf.Origins, wantOrigins)
	}
	for i := range wantOrigins {
		if leaf.Origins[i] != wantOrigins[i] {
			t.Fatalf("origins = %v, want %v", leaf.Origins, wantOrigins)
		}
	}
}

func TestSamePathDifferentValuesRejected(t *testing.T) {
	path := []dataeng.Segment{nseg("a"), nseg("b")}
	fields := []dataeng.Field{
		field(path, 1, 0),
		field(path, 2, 1),
	}
	root, err := dataeng.Build(fields, dataeng.UnlimitedLimits())
	if root != nil {
		t.Fatalf("rejected record must return nil tree, got %+v", root)
	}
	expectReason(t, err, dataeng.ReasonValueMismatch)
}

func TestContainerValuePositionConflict(t *testing.T) {
	tests := []struct {
		name   string
		fields []dataeng.Field
	}{
		{
			name: "object then leaf at same path",
			fields: []dataeng.Field{
				field([]dataeng.Segment{nseg("a"), nseg("b")}, 1, 0),
				field([]dataeng.Segment{nseg("a")}, 2, 1),
			},
		},
		{
			name: "leaf then object at same path",
			fields: []dataeng.Field{
				field([]dataeng.Segment{nseg("a")}, 2, 0),
				field([]dataeng.Segment{nseg("a"), nseg("b")}, 1, 1),
			},
		},
		{
			name: "array then leaf",
			fields: []dataeng.Field{
				field([]dataeng.Segment{nseg("a"), iseg(0)}, 1, 0),
				field([]dataeng.Segment{nseg("a")}, 2, 1),
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root, err := dataeng.Build(tc.fields, dataeng.UnlimitedLimits())
			if root != nil {
				t.Fatalf("expected nil tree on conflict")
			}
			expectReason(t, err, dataeng.ReasonTypeConflict)
		})
	}
}

func TestArrayObjectMixingRejected(t *testing.T) {
	tests := []struct {
		name   string
		fields []dataeng.Field
	}{
		{
			name: "object child where array exists",
			fields: []dataeng.Field{
				field([]dataeng.Segment{nseg("a"), iseg(0)}, 1, 0),
				field([]dataeng.Segment{nseg("a"), nseg("b")}, 2, 1),
			},
		},
		{
			name: "array child where object exists",
			fields: []dataeng.Field{
				field([]dataeng.Segment{nseg("a"), nseg("b")}, 2, 0),
				field([]dataeng.Segment{nseg("a"), iseg(0)}, 1, 1),
			},
		},
		{
			name: "root array versus object",
			fields: []dataeng.Field{
				field([]dataeng.Segment{iseg(0)}, 1, 0),
				field([]dataeng.Segment{nseg("a")}, 2, 1),
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := dataeng.Build(tc.fields, dataeng.UnlimitedLimits())
			expectReason(t, err, dataeng.ReasonTypeConflict)
		})
	}
}

func TestEmptyPathRootValue(t *testing.T) {
	t.Run("equal root values merge", func(t *testing.T) {
		root, err := dataeng.Build([]dataeng.Field{
			field(nil, 42, 3),
			field(nil, 42, 1),
		}, dataeng.UnlimitedLimits())
		if err != nil {
			t.Fatalf("Build: %v", err)
		}
		if root.Kind != dataeng.Leaf || root.Value != 42 {
			t.Fatalf("root leaf wrong: %+v", root)
		}
		if len(root.Origins) != 2 || root.Origins[0] != 1 || root.Origins[1] != 3 {
			t.Fatalf("root origins = %v", root.Origins)
		}
	})

	t.Run("different root values rejected", func(t *testing.T) {
		_, err := dataeng.Build([]dataeng.Field{
			field(nil, 1, 0),
			field(nil, 2, 1),
		}, dataeng.UnlimitedLimits())
		expectReason(t, err, dataeng.ReasonValueMismatch)
	})

	t.Run("root value against container rejected", func(t *testing.T) {
		_, err := dataeng.Build([]dataeng.Field{
			field([]dataeng.Segment{nseg("a")}, 1, 0),
			field(nil, 2, 1),
		}, dataeng.UnlimitedLimits())
		expectReason(t, err, dataeng.ReasonTypeConflict)
	})

	t.Run("container against root value rejected", func(t *testing.T) {
		_, err := dataeng.Build([]dataeng.Field{
			field(nil, 2, 0),
			field([]dataeng.Segment{nseg("a")}, 1, 1),
		}, dataeng.UnlimitedLimits())
		expectReason(t, err, dataeng.ReasonTypeConflict)
	})
}

func TestSparseBudgets(t *testing.T) {
	t.Run("max array index inclusive", func(t *testing.T) {
		ok := []dataeng.Field{
			field([]dataeng.Segment{nseg("a"), iseg(2)}, "x", 0),
		}
		if _, err := dataeng.Build(ok, dataeng.Limits{MaxArrayIndex: 2}); err != nil {
			t.Fatalf("index 2 within cap 2 rejected: %v", err)
		}
		_, err := dataeng.Build(ok, dataeng.Limits{MaxArrayIndex: 1})
		expectReason(t, err, dataeng.ReasonIndexTooLarge)
	})

	t.Run("cell budget counts all arrays", func(t *testing.T) {
		fields := []dataeng.Field{
			field([]dataeng.Segment{nseg("a"), iseg(2)}, 1, 0),
			field([]dataeng.Segment{nseg("b"), iseg(1)}, 2, 1),
		}
		if _, err := dataeng.Build(fields, dataeng.Limits{MaxArrayIndex: -1, MaxCells: 5}); err != nil {
			t.Fatalf("5 cells within budget rejected: %v", err)
		}
		_, err := dataeng.Build(fields, dataeng.Limits{MaxArrayIndex: -1, MaxCells: 4})
		expectReason(t, err, dataeng.ReasonCellBudget)
	})

	t.Run("holes count toward budget", func(t *testing.T) {
		fields := []dataeng.Field{
			field([]dataeng.Segment{iseg(9)}, "x", 0),
		}
		if _, err := dataeng.Build(fields, dataeng.Limits{MaxArrayIndex: -1, MaxCells: 10}); err != nil {
			t.Fatalf("10 cells within budget rejected: %v", err)
		}
		_, err := dataeng.Build(fields, dataeng.Limits{MaxArrayIndex: -1, MaxCells: 9})
		expectReason(t, err, dataeng.ReasonCellBudget)
	})

	t.Run("out of order indices still bounded", func(t *testing.T) {
		fields := []dataeng.Field{
			field([]dataeng.Segment{iseg(1)}, "a", 0),
			field([]dataeng.Segment{iseg(0)}, "b", 1),
			field([]dataeng.Segment{iseg(4)}, "c", 2),
		}
		_, err := dataeng.Build(fields, dataeng.Limits{MaxArrayIndex: -1, MaxCells: 5})
		if err != nil {
			t.Fatalf("5 cells within budget rejected: %v", err)
		}
		_, err = dataeng.Build(fields, dataeng.Limits{MaxArrayIndex: -1, MaxCells: 3})
		expectReason(t, err, dataeng.ReasonCellBudget)
	})
}

func TestGiantIndexNeverAllocates(t *testing.T) {
	fields := []dataeng.Field{
		field([]dataeng.Segment{iseg(1 << 30)}, "boom", 0),
	}
	_, err := dataeng.Build(fields, dataeng.Limits{MaxArrayIndex: -1, MaxCells: 1024})
	expectReason(t, err, dataeng.ReasonCellBudget)

	_, err = dataeng.Build(fields, dataeng.Limits{MaxArrayIndex: 1024})
	expectReason(t, err, dataeng.ReasonIndexTooLarge)
}

func TestUTF8ByteOrdering(t *testing.T) {
	// "é" (0xC3 0xA9) sorts after "z" (0x7A) on raw bytes, even though some
	// locale-aware collations would order them differently.
	fields := []dataeng.Field{
		field([]dataeng.Segment{nseg("é")}, 1, 0),
		field([]dataeng.Segment{nseg("z")}, 2, 1),
		field([]dataeng.Segment{nseg("a")}, 3, 2),
	}
	root, err := dataeng.Build(fields, dataeng.UnlimitedLimits())
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	names := []string{root.Fields[0].Name, root.Fields[1].Name, root.Fields[2].Name}
	want := []string{"a", "z", "é"}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("order = %v, want %v", names, want)
		}
	}
}

func TestNestedArraysAccumulateCells(t *testing.T) {
	// Outer index 2 costs 3 cells; inner index 3 costs 4 cells: total 7.
	fields := []dataeng.Field{
		field([]dataeng.Segment{iseg(2), iseg(3)}, "x", 0),
	}
	if _, err := dataeng.Build(fields, dataeng.Limits{MaxArrayIndex: -1, MaxCells: 7}); err != nil {
		t.Fatalf("7 cells within budget rejected: %v", err)
	}
	_, err := dataeng.Build(fields, dataeng.Limits{MaxArrayIndex: -1, MaxCells: 6})
	expectReason(t, err, dataeng.ReasonCellBudget)
}

func TestInvalidInputs(t *testing.T) {
	t.Run("negative index", func(t *testing.T) {
		_, err := dataeng.Build([]dataeng.Field{
			field([]dataeng.Segment{iseg(-1)}, 1, 0),
		}, dataeng.UnlimitedLimits())
		expectReason(t, err, dataeng.ReasonInvalidInput)
	})

	t.Run("negative ordinal", func(t *testing.T) {
		_, err := dataeng.Build([]dataeng.Field{
			field([]dataeng.Segment{nseg("a")}, 1, -5),
		}, dataeng.UnlimitedLimits())
		expectReason(t, err, dataeng.ReasonInvalidInput)
	})

	t.Run("unsupported value", func(t *testing.T) {
		_, err := dataeng.Build([]dataeng.Field{
			field([]dataeng.Segment{nseg("a")}, []int{1, 2}, 0),
		}, dataeng.UnlimitedLimits())
		expectReason(t, err, dataeng.ReasonInvalidInput)
	})

	t.Run("bad limits", func(t *testing.T) {
		_, err := dataeng.Build(nil, dataeng.Limits{MaxArrayIndex: -2})
		expectReason(t, err, dataeng.ReasonInvalidInput)

		_, err = dataeng.Build(nil, dataeng.Limits{MaxArrayIndex: -1, MaxCells: -1})
		expectReason(t, err, dataeng.ReasonInvalidInput)
	})
}

func TestEmptyRecord(t *testing.T) {
	root, err := dataeng.Build(nil, dataeng.UnlimitedLimits())
	if err != nil {
		t.Fatalf("empty record: %v", err)
	}
	if root != nil {
		t.Fatalf("empty record must yield nil root, got %+v", root)
	}
}

func TestNilLeafValueDistinctFromMissing(t *testing.T) {
	root, err := dataeng.Build([]dataeng.Field{
		field([]dataeng.Segment{iseg(0), iseg(2)}, nil, 0),
	}, dataeng.UnlimitedLimits())
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	outer := root.Elems
	if outer[0].Kind != dataeng.Array {
		t.Fatalf("outer[0] = %v", outer[0].Kind)
	}
	inner := outer[0].Elems
	if !inner[0].IsMissing() || !inner[1].IsMissing() {
		t.Fatalf("holes 0 and 1 must be missing")
	}
	if inner[2].Kind != dataeng.Leaf || inner[2].Value != nil {
		t.Fatalf("explicit nil leaf must remain a leaf, got %+v", inner[2])
	}
	if len(inner[2].Origins) != 1 || inner[2].Origins[0] != 0 {
		t.Fatalf("nil leaf origins = %v", inner[2].Origins)
	}
}

func TestConflictErrorFormatting(t *testing.T) {
	_, err := dataeng.Build([]dataeng.Field{
		field([]dataeng.Segment{nseg("a"), iseg(3)}, "x", 2),
	}, dataeng.Limits{MaxArrayIndex: 1})
	message := err.Error()
	for _, fragment := range []string{"index_too_large", ".a[3]", "ordinal 2"} {
		if !strings.Contains(message, fragment) {
			t.Fatalf("error %q missing fragment %q", message, fragment)
		}
	}

	_, err = dataeng.Build([]dataeng.Field{
		field(nil, 1, 0),
		field(nil, 2, 1),
	}, dataeng.UnlimitedLimits())
	if !strings.Contains(err.Error(), "<root>") {
		t.Fatalf("root error %q must contain <root>", err.Error())
	}
}

func TestUnknownSegmentKindRejected(t *testing.T) {
	bad := dataeng.Segment{}
	_, err := dataeng.Build([]dataeng.Field{
		field([]dataeng.Segment{bad}, 1, 0),
	}, dataeng.UnlimitedLimits())
	expectReason(t, err, dataeng.ReasonInvalidInput)
}
