package dataeng_test

import (
	"errors"
	"reflect"
	"testing"

	"example.org/dataeng13/q0037"
)

func copyRelation(relation dataeng.Relation) dataeng.Relation {
	relation.Columns = append([]dataeng.Column(nil), relation.Columns...)
	return relation
}

func TestRelationValidation(t *testing.T) {
	base := fixture(t, accountsID).relation
	cases := []struct {
		name     string
		relation dataeng.Relation
	}{
		{"zero ID", func() dataeng.Relation {
			r := copyRelation(base)
			r.ID = 0
			return r
		}()},
		{"empty name", func() dataeng.Relation {
			r := copyRelation(base)
			r.Name = " "
			return r
		}()},
		{"no columns", func() dataeng.Relation {
			r := copyRelation(base)
			r.Columns = nil
			return r
		}()},
		{"duplicate column", func() dataeng.Relation {
			r := copyRelation(base)
			r.Columns[1].Name = r.Columns[0].Name
			return r
		}()},
		{"empty column name", func() dataeng.Relation {
			r := copyRelation(base)
			r.Columns[1].Name = ""
			return r
		}()},
		{"empty column type", func() dataeng.Relation {
			r := copyRelation(base)
			r.Columns[1].Type = ""
			return r
		}()},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := dataeng.New()
			err := r.AddRelation(tc.relation)
			wantErr(t, err, dataeng.ErrInvalidRelation)
			if _, ok := r.RelationByID(accountsID); ok {
				t.Fatal("invalid relation was recorded")
			}
		})
	}

	r := newReassembler(t, accountsID)
	invalid := copyRelation(base)
	invalid.Columns[0].Name = ""
	if err := r.AddRelation(invalid); !errors.Is(err, dataeng.ErrInvalidRelation) {
		t.Fatalf("got %v, want ErrInvalidRelation", err)
	}
	stored, ok := r.RelationByID(accountsID)
	if !ok || !reflect.DeepEqual(stored, base) {
		t.Fatalf("invalid replacement disturbed the previous relation")
	}
}

func TestResetClearsEverything(t *testing.T) {
	r := newReassembler(t, accountsID)
	mustIngest(t, r, dataeng.Change{
		Relation:  accountsID,
		Operation: dataeng.Insert,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("1"), text("n"), external("reset-body"),
		}},
	})
	if r.PendingChanges() != 1 || r.PendingChunks() != 1 {
		t.Fatalf("setup did not create pending state")
	}

	r.Reset()
	if r.PendingChanges() != 0 || r.PendingChunks() != 0 {
		t.Fatalf("Reset left pending state")
	}
	if _, ok := r.RelationByID(accountsID); ok {
		t.Fatalf("Reset left a relation")
	}
	if _, err := r.IngestChunk(dataeng.ExternalChunk{
		ID: "reset-body", Index: 0, Total: 1, Data: []byte("x"),
	}); !errors.Is(err, dataeng.ErrUnknownExternal) {
		t.Fatalf("Reset left external state: %v", err)
	}
}

func TestChangeAndTupleShapeValidation(t *testing.T) {
	r := newReassembler(t, accountsID)

	updateNil := dataeng.Change{Relation: accountsID, Operation: dataeng.Update}
	_, err := r.IngestChange(updateNil)
	wantErr(t, err, dataeng.ErrInvalidChange)

	unknown := dataeng.Change{
		Relation:  accountsID,
		Operation: dataeng.Operation(99),
		New:       &dataeng.Tuple{Values: []dataeng.Value{text("1"), text("n"), text("b")}},
	}
	_, err = r.IngestChange(unknown)
	wantErr(t, err, dataeng.ErrInvalidChange)

	validNew := &dataeng.Tuple{Values: []dataeng.Value{text("1"), text("n"), text("b")}}
	badTuples := []struct {
		name   string
		change dataeng.Change
		want   error
	}{
		{
			name: "new tuple misses a column",
			change: dataeng.Change{
				Relation: accountsID, Operation: dataeng.Insert,
				New: &dataeng.Tuple{Columns: []int{0, 1}, Values: []dataeng.Value{text("1"), text("n")}},
			},
			want: dataeng.ErrInvalidTuple,
		},
		{
			name: "new tuple column out of range",
			change: dataeng.Change{
				Relation: accountsID, Operation: dataeng.Insert,
				New: &dataeng.Tuple{Columns: []int{0, 1, 3}, Values: []dataeng.Value{text("1"), text("n"), text("b")}},
			},
			want: dataeng.ErrInvalidTuple,
		},
		{
			name: "duplicate column",
			change: dataeng.Change{
				Relation: accountsID, Operation: dataeng.Insert,
				New: &dataeng.Tuple{Columns: []int{0, 0, 1}, Values: []dataeng.Value{text("1"), text("n"), text("b")}},
			},
			want: dataeng.ErrInvalidTuple,
		},
		{
			name: "value count mismatch",
			change: dataeng.Change{
				Relation: accountsID, Operation: dataeng.Insert,
				New: &dataeng.Tuple{Columns: []int{0, 1}, Values: []dataeng.Value{text("1"), text("n"), text("b")}},
			},
			want: dataeng.ErrInvalidTuple,
		},
		{
			name: "old tuple column out of range",
			change: dataeng.Change{
				Relation: accountsID, Operation: dataeng.Update,
				New: validNew,
				Old: &dataeng.Tuple{Columns: []int{7}, Values: []dataeng.Value{text("1")}},
			},
			want: dataeng.ErrInvalidTuple,
		},
		{
			name: "unknown value kind",
			change: dataeng.Change{
				Relation: accountsID, Operation: dataeng.Insert,
				New: &dataeng.Tuple{Values: []dataeng.Value{
					text("1"), dataeng.Value{Kind: dataeng.ValueKind(99)}, text("b"),
				}},
			},
			want: dataeng.ErrInvalidValue,
		},
	}
	for _, tc := range badTuples {
		t.Run(tc.name, func(t *testing.T) {
			_, err := r.IngestChange(tc.change)
			wantErr(t, err, tc.want)
		})
	}
}

func TestOldTupleColumnsAreNormalized(t *testing.T) {
	r := newReassembler(t, accountsID)
	events := mustIngest(t, r, dataeng.Change{
		Relation:  accountsID,
		Operation: dataeng.Update,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("1"), text("new"), text("body"),
		}},
		Old: &dataeng.Tuple{
			Columns: []int{1, 0},
			Values:  []dataeng.Value{text("old"), text("1")},
		},
	})

	assertRow(t, events[0].Old, &dataeng.Row{
		Columns: []int{0, 1},
		Values:  []dataeng.Value{text("1"), text("old")},
	})
	if length := events[0].New.Len(); length != 3 {
		t.Fatalf("Row.Len() = %d, want 3", length)
	}
	value, ok := events[0].New.ValueFor(1)
	if !ok || value.Text != "new" {
		t.Fatalf("ValueFor(1) = %#v, %v", value, ok)
	}
	if _, ok := events[0].New.ValueFor(8); ok {
		t.Fatalf("ValueFor(8) unexpectedly found a column")
	}
}

func TestNullInNonIdentityColumn(t *testing.T) {
	r := newReassembler(t, accountsID)
	events := mustIngest(t, r, dataeng.Change{
		Relation:  accountsID,
		Operation: dataeng.Insert,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("1"), null(), text("body"),
		}},
	})
	assertRow(t, events[0].New, &dataeng.Row{
		Columns: []int{0, 1, 2},
		Values:  []dataeng.Value{text("1"), null(), text("body")},
	})
}

func TestValueConstructorsAndStringer(t *testing.T) {
	if !dataeng.NullValue().IsNull() {
		t.Fatalf("NullValue did not produce NULL")
	}
	if dataeng.TextValue("x").IsExternal() {
		t.Fatalf("TextValue is external")
	}
	source := []byte{1, 2}
	copied := dataeng.BinaryValue(source)
	source[0] = 9
	if !reflect.DeepEqual(copied.Bytes, []byte{1, 2}) {
		t.Fatalf("BinaryValue did not copy its input")
	}
	if !dataeng.ExternalValue("id").IsExternal() {
		t.Fatalf("ExternalValue is not external")
	}

	for operation, want := range map[dataeng.Operation]string{
		dataeng.Insert:       "insert",
		dataeng.Update:       "update",
		dataeng.Delete:       "delete",
		dataeng.Operation(0): "unknown",
	} {
		if got := operation.String(); got != want {
			t.Fatalf("%d.String() = %q, want %q", operation, got, want)
		}
	}
}
