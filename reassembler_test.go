package dataeng_test

import (
	"errors"
	"reflect"
	"testing"

	"example.org/dataeng13/q0037"
)

const (
	accountsID  dataeng.RelationID = 11
	eventsID    dataeng.RelationID = 12
	typedID     dataeng.RelationID = 13
	changingID  dataeng.RelationID = 14
	binaryID    dataeng.RelationID = 15
	keylessID   dataeng.RelationID = 16
	compositeID dataeng.RelationID = 17
)

// These tables are deliberately literal test fixtures. They are not derived
// from the package's relation registry, so they can catch a wrong key-column
// or column-type implementation.
type relationFixture struct {
	relation   dataeng.Relation
	keyColumns []int
}

var fixtures = map[dataeng.RelationID]relationFixture{
	accountsID: {
		relation: dataeng.Relation{
			ID:        accountsID,
			Namespace: "app",
			Name:      "accounts",
			Columns: []dataeng.Column{
				{Name: "id", Type: dataeng.TypeInt8, Identity: true},
				{Name: "name", Type: dataeng.TypeText},
				{Name: "body", Type: dataeng.TypeText},
			},
		},
		keyColumns: []int{0},
	},
	eventsID: {
		relation: dataeng.Relation{
			ID:   eventsID,
			Name: "events",
			Columns: []dataeng.Column{
				{Name: "label", Type: dataeng.TypeText},
				{Name: "value", Type: dataeng.TypeInt4},
			},
		},
	},
	typedID: {
		relation: dataeng.Relation{
			ID:   typedID,
			Name: "typed_values",
			Columns: []dataeng.Column{
				{Name: "id", Type: dataeng.TypeInt8, Identity: true},
				{Name: "flag", Type: dataeng.TypeBool},
				{Name: "count", Type: dataeng.TypeInt4},
				{Name: "amount", Type: dataeng.TypeNumeric},
				{Name: "happened", Type: dataeng.TypeTimestamp},
				{Name: "token", Type: dataeng.TypeUUID},
				{Name: "doc", Type: dataeng.TypeJSONB},
			},
		},
		keyColumns: []int{0},
	},
	changingID: {
		relation: dataeng.Relation{
			ID:   changingID,
			Name: "changing_types",
			Columns: []dataeng.Column{
				{Name: "id", Type: dataeng.TypeInt8, Identity: true},
				{Name: "value", Type: dataeng.TypeInt4},
			},
		},
		keyColumns: []int{0},
	},
	binaryID: {
		relation: dataeng.Relation{
			ID:   binaryID,
			Name: "binary_values",
			Columns: []dataeng.Column{
				{Name: "id", Type: dataeng.TypeInt8, Identity: true},
				{Name: "body", Type: dataeng.TypeBytea},
			},
		},
		keyColumns: []int{0},
	},
	keylessID: {
		relation: dataeng.Relation{
			ID:   keylessID,
			Name: "keyless",
			Columns: []dataeng.Column{
				{Name: "label", Type: dataeng.TypeText},
				{Name: "value", Type: dataeng.TypeInt4},
			},
		},
	},
	compositeID: {
		relation: dataeng.Relation{
			ID:   compositeID,
			Name: "composite",
			Columns: []dataeng.Column{
				{Name: "tenant", Type: dataeng.TypeInt4, Identity: true},
				{Name: "value", Type: dataeng.TypeText},
				{Name: "id", Type: dataeng.TypeInt8, Identity: true},
			},
		},
		keyColumns: []int{0, 2},
	},
}

func fixture(t *testing.T, id dataeng.RelationID) relationFixture {
	t.Helper()
	table, ok := fixtures[id]
	if !ok {
		t.Fatalf("no independent fixture for relation %d", id)
	}
	table.relation.Columns = append([]dataeng.Column(nil), table.relation.Columns...)
	table.keyColumns = append([]int(nil), table.keyColumns...)
	return table
}

func newReassembler(t *testing.T, ids ...dataeng.RelationID) *dataeng.Reassembler {
	t.Helper()
	r := dataeng.New()
	for _, id := range ids {
		if err := r.AddRelation(fixture(t, id).relation); err != nil {
			t.Fatalf("AddRelation(%d): %v", id, err)
		}
	}
	return r
}

func mustIngest(t *testing.T, r *dataeng.Reassembler, change dataeng.Change) []dataeng.Event {
	t.Helper()
	events, err := r.IngestChange(change)
	if err != nil {
		t.Fatalf("IngestChange: %v", err)
	}
	return events
}

func wantErr(t *testing.T, err, target error) {
	t.Helper()
	if !errors.Is(err, target) {
		t.Fatalf("got error %v, want errors.Is(_, %v)", err, target)
	}
}

func text(s string) dataeng.Value {
	return dataeng.Value{Kind: dataeng.ValueText, Text: s}
}

func null() dataeng.Value {
	return dataeng.Value{Kind: dataeng.ValueNull}
}

func binary(data []byte) dataeng.Value {
	return dataeng.Value{Kind: dataeng.ValueBinary, Bytes: data}
}

func external(id dataeng.ExternalID) dataeng.Value {
	return dataeng.Value{Kind: dataeng.ValueExternal, Ref: id}
}

func assertRow(t *testing.T, got *dataeng.Row, want *dataeng.Row) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("row mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func assertEventRelation(t *testing.T, event dataeng.Event, id dataeng.RelationID) relationFixture {
	t.Helper()
	table := fixture(t, id)
	if !reflect.DeepEqual(event.Relation, table.relation) {
		t.Fatalf("relation mismatch\n got: %#v\nwant: %#v", event.Relation, table.relation)
	}
	return table
}

func assertKeyColumns(t *testing.T, table relationFixture, key *dataeng.Row) {
	t.Helper()
	if key == nil {
		if len(table.keyColumns) != 0 {
			t.Fatalf("key row is nil, independent table expects columns %v", table.keyColumns)
		}
		return
	}
	if !reflect.DeepEqual(key.Columns, table.keyColumns) {
		t.Fatalf("key columns are %v, independent table expects %v", key.Columns, table.keyColumns)
	}
}

func TestTupleBeforeRelationFails(t *testing.T) {
	r := dataeng.New()
	change := dataeng.Change{
		Relation:  accountsID,
		Operation: dataeng.Update,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("1"), text("new"), text("payload"),
		}},
	}

	if _, err := r.IngestChange(change); !errors.Is(err, dataeng.ErrRelationNotFound) {
		t.Fatalf("IngestChange before AddRelation: got %v, want ErrRelationNotFound", err)
	}
	if r.PendingChanges() != 0 {
		t.Fatalf("failed tuple left %d pending changes", r.PendingChanges())
	}

	r = newReassembler(t, accountsID)
	events := mustIngest(t, r, change)
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	assertEventRelation(t, events[0], accountsID)

	r.RemoveRelation(accountsID)
	if _, err := r.IngestChange(change); !errors.Is(err, dataeng.ErrRelationNotFound) {
		t.Fatalf("IngestChange after RemoveRelation: got %v, want ErrRelationNotFound", err)
	}
}

func TestNewOldAndKeyTupleInOneRecord(t *testing.T) {
	r := newReassembler(t, accountsID)
	events := mustIngest(t, r, dataeng.Change{
		Relation:  accountsID,
		Operation: dataeng.Update,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("2"), text("new name"), text("new body"),
		}},
		Old: &dataeng.Tuple{Values: []dataeng.Value{
			text("1"), text("old name"), text("old body"),
		}},
		Key: &dataeng.Tuple{Values: []dataeng.Value{text("1")}},
	})
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}

	event := events[0]
	table := assertEventRelation(t, event, accountsID)
	assertRow(t, event.New, &dataeng.Row{
		Columns: []int{0, 1, 2},
		Values:  []dataeng.Value{text("2"), text("new name"), text("new body")},
	})
	assertRow(t, event.Old, &dataeng.Row{
		Columns: []int{0, 1, 2},
		Values:  []dataeng.Value{text("1"), text("old name"), text("old body")},
	})
	assertRow(t, event.Key, &dataeng.Row{
		Columns: []int{0},
		Values:  []dataeng.Value{text("1")},
	})
	assertKeyColumns(t, table, event.Key)
}

func TestKeyTupleRules(t *testing.T) {
	t.Run("non-identity column", func(t *testing.T) {
		r := newReassembler(t, accountsID)
		_, err := r.IngestChange(dataeng.Change{
			Relation:  accountsID,
			Operation: dataeng.Update,
			New:       &dataeng.Tuple{Values: []dataeng.Value{text("1"), text("n"), text("b")}},
			Key:       &dataeng.Tuple{Columns: []int{0, 1}, Values: []dataeng.Value{text("1"), text("n")}},
		})
		wantErr(t, err, dataeng.ErrKeyNotIdentity)
	})

	t.Run("missing identity column", func(t *testing.T) {
		r := newReassembler(t, accountsID)
		_, err := r.IngestChange(dataeng.Change{
			Relation:  accountsID,
			Operation: dataeng.Update,
			New:       &dataeng.Tuple{Values: []dataeng.Value{text("1"), text("n"), text("b")}},
			Key:       &dataeng.Tuple{Columns: []int{}, Values: []dataeng.Value{}},
		})
		wantErr(t, err, dataeng.ErrMissingKey)
	})

	t.Run("relation has no identity columns", func(t *testing.T) {
		r := newReassembler(t, keylessID)
		_, err := r.IngestChange(dataeng.Change{
			Relation:  keylessID,
			Operation: dataeng.Update,
			New:       &dataeng.Tuple{Values: []dataeng.Value{text("n"), text("1")}},
			Key:       &dataeng.Tuple{Values: []dataeng.Value{}},
		})
		wantErr(t, err, dataeng.ErrNoIdentity)
	})

	t.Run("NULL identity value", func(t *testing.T) {
		r := newReassembler(t, accountsID)
		_, err := r.IngestChange(dataeng.Change{
			Relation:  accountsID,
			Operation: dataeng.Update,
			New:       &dataeng.Tuple{Values: []dataeng.Value{null(), text("n"), text("b")}},
		})
		wantErr(t, err, dataeng.ErrNullKey)
	})

	t.Run("key disagrees with old tuple", func(t *testing.T) {
		r := newReassembler(t, accountsID)
		_, err := r.IngestChange(dataeng.Change{
			Relation:  accountsID,
			Operation: dataeng.Update,
			New:       &dataeng.Tuple{Values: []dataeng.Value{text("2"), text("n"), text("b")}},
			Old:       &dataeng.Tuple{Values: []dataeng.Value{text("1"), text("o"), text("b")}},
			Key:       &dataeng.Tuple{Values: []dataeng.Value{text("2")}},
		})
		wantErr(t, err, dataeng.ErrKeyMismatch)
	})

	t.Run("primary-key change keeps the old key", func(t *testing.T) {
		r := newReassembler(t, accountsID)
		events := mustIngest(t, r, dataeng.Change{
			Relation:  accountsID,
			Operation: dataeng.Update,
			New:       &dataeng.Tuple{Values: []dataeng.Value{text("2"), text("n"), text("b")}},
			Old:       &dataeng.Tuple{Values: []dataeng.Value{text("1"), text("o"), text("b")}},
			Key:       &dataeng.Tuple{Values: []dataeng.Value{text("1")}},
		})
		if len(events) != 1 {
			t.Fatalf("got %d events, want 1", len(events))
		}
		assertRow(t, events[0].Key, &dataeng.Row{
			Columns: []int{0},
			Values:  []dataeng.Value{text("1")},
		})
	})

	t.Run("explicit key columns are normalized to identity order", func(t *testing.T) {
		// The tuple still has to name exactly the identity columns, but their
		// order in the input does not have to match the relation order.
		r := newReassembler(t, accountsID)
		events := mustIngest(t, r, dataeng.Change{
			Relation:  accountsID,
			Operation: dataeng.Insert,
			New:       &dataeng.Tuple{Values: []dataeng.Value{text("1"), text("n"), text("b")}},
			Key:       &dataeng.Tuple{Columns: []int{0}, Values: []dataeng.Value{text("1")}},
		})
		assertRow(t, events[0].Key, &dataeng.Row{
			Columns: []int{0},
			Values:  []dataeng.Value{text("1")},
		})
	})
}

func TestKeyDerivedFromAvailableRows(t *testing.T) {
	t.Run("insert from new tuple", func(t *testing.T) {
		r := newReassembler(t, accountsID)
		events := mustIngest(t, r, dataeng.Change{
			Relation:  accountsID,
			Operation: dataeng.Insert,
			New:       &dataeng.Tuple{Values: []dataeng.Value{text("5"), text("n"), text("b")}},
		})
		assertRow(t, events[0].Key, &dataeng.Row{Columns: []int{0}, Values: []dataeng.Value{text("5")}})
	})

	t.Run("update from partial old tuple", func(t *testing.T) {
		r := newReassembler(t, accountsID)
		events := mustIngest(t, r, dataeng.Change{
			Relation:  accountsID,
			Operation: dataeng.Update,
			New:       &dataeng.Tuple{Values: []dataeng.Value{text("1"), text("n"), text("b")}},
			Old:       &dataeng.Tuple{Columns: []int{0}, Values: []dataeng.Value{text("1")}},
		})
		assertRow(t, events[0].Old, &dataeng.Row{Columns: []int{0}, Values: []dataeng.Value{text("1")}})
		assertRow(t, events[0].Key, &dataeng.Row{Columns: []int{0}, Values: []dataeng.Value{text("1")}})
	})

	t.Run("delete from full old tuple", func(t *testing.T) {
		r := newReassembler(t, accountsID)
		events := mustIngest(t, r, dataeng.Change{
			Relation:  accountsID,
			Operation: dataeng.Delete,
			Old:       &dataeng.Tuple{Values: []dataeng.Value{text("9"), text("n"), text("b")}},
		})
		assertRow(t, events[0].Key, &dataeng.Row{Columns: []int{0}, Values: []dataeng.Value{text("9")}})
	})

	t.Run("delete from key tuple", func(t *testing.T) {
		r := newReassembler(t, accountsID)
		events := mustIngest(t, r, dataeng.Change{
			Relation:  accountsID,
			Operation: dataeng.Delete,
			Key:       &dataeng.Tuple{Values: []dataeng.Value{text("9")}},
		})
		if events[0].New != nil || events[0].Old != nil {
			t.Fatalf("key-only delete produced new/old rows")
		}
		assertRow(t, events[0].Key, &dataeng.Row{Columns: []int{0}, Values: []dataeng.Value{text("9")}})
	})

	t.Run("delete without identity", func(t *testing.T) {
		r := newReassembler(t, accountsID)
		_, err := r.IngestChange(dataeng.Change{
			Relation:  accountsID,
			Operation: dataeng.Delete,
			Old:       &dataeng.Tuple{Columns: []int{1}, Values: []dataeng.Value{text("name")}},
		})
		wantErr(t, err, dataeng.ErrMissingKey)
	})

	t.Run("keyless relation has no key row", func(t *testing.T) {
		r := newReassembler(t, keylessID)
		events := mustIngest(t, r, dataeng.Change{
			Relation:  keylessID,
			Operation: dataeng.Insert,
			New:       &dataeng.Tuple{Values: []dataeng.Value{text("label"), text("7")}},
		})
		if events[0].Key != nil {
			t.Fatalf("keyless relation produced key row %#v", events[0].Key)
		}
	})
}

func TestCompositeIdentityColumns(t *testing.T) {
	r := newReassembler(t, compositeID)
	table := fixture(t, compositeID)
	events := mustIngest(t, r, dataeng.Change{
		Relation:  compositeID,
		Operation: dataeng.Insert,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("7"), text("payload"), text("42"),
		}},
	})
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	assertRow(t, events[0].Key, &dataeng.Row{
		Columns: []int{0, 2},
		Values:  []dataeng.Value{text("7"), text("42")},
	})
	assertKeyColumns(t, table, events[0].Key)

	// An explicit key may list the two identities in either order. A non-key
	// column in that list is still rejected.
	events = mustIngest(t, r, dataeng.Change{
		Relation:  compositeID,
		Operation: dataeng.Insert,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("7"), text("payload"), text("42"),
		}},
		Key: &dataeng.Tuple{
			Columns: []int{2, 0},
			Values:  []dataeng.Value{text("42"), text("7")},
		},
	})
	assertRow(t, events[0].Key, &dataeng.Row{
		Columns: []int{0, 2},
		Values:  []dataeng.Value{text("7"), text("42")},
	})

	_, err := r.IngestChange(dataeng.Change{
		Relation:  compositeID,
		Operation: dataeng.Insert,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("7"), text("payload"), text("42"),
		}},
		Key: &dataeng.Tuple{
			Columns: []int{0, 1},
			Values:  []dataeng.Value{text("7"), text("payload")},
		},
	})
	wantErr(t, err, dataeng.ErrKeyNotIdentity)

	_, err = r.IngestChange(dataeng.Change{
		Relation:  compositeID,
		Operation: dataeng.Insert,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("7"), text("payload"), text("42"),
		}},
		Key: &dataeng.Tuple{Columns: []int{0}, Values: []dataeng.Value{text("7")}},
	})
	wantErr(t, err, dataeng.ErrMissingKey)
}

func TestDeleteShapeValidation(t *testing.T) {
	r := newReassembler(t, accountsID)
	_, err := r.IngestChange(dataeng.Change{
		Relation:  accountsID,
		Operation: dataeng.Delete,
	})
	wantErr(t, err, dataeng.ErrInvalidChange)

	_, err = r.IngestChange(dataeng.Change{
		Relation:  accountsID,
		Operation: dataeng.Delete,
		New:       &dataeng.Tuple{Values: []dataeng.Value{text("1"), text("n"), text("b")}},
	})
	wantErr(t, err, dataeng.ErrInvalidChange)

	_, err = r.IngestChange(dataeng.Change{
		Relation:  accountsID,
		Operation: dataeng.Update,
	})
	wantErr(t, err, dataeng.ErrInvalidChange)
}

func TestColumnTypesComeFromRelation(t *testing.T) {
	r := newReassembler(t, typedID)
	valid := dataeng.Change{
		Relation:  typedID,
		Operation: dataeng.Insert,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("1"),
			text("true"),
			text("42"),
			text("12.50"),
			text("2026-11-13 12:00:00"),
			text("550e8400-e29b-41d4-a716-446655440000"),
			text(`{"ok":true}`),
		}},
	}
	events := mustIngest(t, r, valid)
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}

	cases := []struct {
		name  string
		index int
		value dataeng.Value
	}{
		{"boolean", 1, text("maybe")},
		{"int4", 2, text("not an integer")},
		{"numeric", 3, text("12x5")},
		{"timestamp", 4, text("not a timestamp")},
		{"uuid", 5, text("not-a-uuid")},
		{"jsonb", 6, text("{")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			values := []dataeng.Value{
				text("1"), text("true"), text("42"), text("12.50"),
				text("2026-11-13 12:00:00"), text("550e8400-e29b-41d4-a716-446655440000"),
				text(`{"ok":true}`),
			}
			values[tc.index] = tc.value
			_, err := r.IngestChange(dataeng.Change{
				Relation:  typedID,
				Operation: dataeng.Insert,
				New:       &dataeng.Tuple{Values: values},
			})
			wantErr(t, err, dataeng.ErrInvalidValue)
		})
	}

	// Binary values are opaque; the package cannot inspect their encoding.
	binaryChange := valid
	binaryChange.New = &dataeng.Tuple{Values: []dataeng.Value{
		text("2"), binary([]byte{1}), text("43"), text("13.5"),
		text("2026-11-13 12:00:00"), text("550e8400-e29b-41d4-a716-446655440000"),
		text(`{"ok":false}`),
	}}
	if events := mustIngest(t, r, binaryChange); len(events) != 1 {
		t.Fatalf("binary value was not accepted")
	}
}

func TestRelationReplacementChangesValidation(t *testing.T) {
	r := newReassembler(t, changingID)
	intRelation := fixture(t, changingID).relation
	insert := dataeng.Change{
		Relation:  changingID,
		Operation: dataeng.Insert,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("1"), text("42"),
		}},
	}
	if events := mustIngest(t, r, insert); len(events) != 1 {
		t.Fatalf("int4 value rejected")
	}

	boolRelation := intRelation
	boolRelation.Columns = append([]dataeng.Column(nil), intRelation.Columns...)
	boolRelation.Columns[1].Type = dataeng.TypeBool
	if err := r.AddRelation(boolRelation); err != nil {
		t.Fatalf("AddRelation(bool): %v", err)
	}
	if _, err := r.IngestChange(insert); !errors.Is(err, dataeng.ErrInvalidValue) {
		t.Fatalf("value was not validated against the replacement relation: %v", err)
	}
}

func TestRelationInputCannotMutateRegistry(t *testing.T) {
	r := newReassembler(t, accountsID)
	table := fixture(t, accountsID)

	got, ok := r.RelationByID(accountsID)
	if !ok {
		t.Fatal("RelationByID returned !ok")
	}
	if !reflect.DeepEqual(got, table.relation) {
		t.Fatalf("stored relation differs from literal fixture")
	}
	got.Columns[0].Name = "mutated"
	again, _ := r.RelationByID(accountsID)
	if !reflect.DeepEqual(again, table.relation) {
		t.Fatalf("caller mutated the registry")
	}

	input := table.relation
	input.Columns[1].Name = "changed after AddRelation"
	if err := r.AddRelation(input); err != nil {
		t.Fatalf("AddRelation: %v", err)
	}
	stored, _ := r.RelationByID(accountsID)
	if stored.Columns[1].Name != "changed after AddRelation" {
		t.Fatalf("AddRelation did not store its input")
	}
	input.Columns[1].Name = "changed again"
	stored, _ = r.RelationByID(accountsID)
	if stored.Columns[1].Name != "changed after AddRelation" {
		t.Fatalf("AddRelation kept a reference to the caller's slice")
	}
}

func TestRowsOwnTheirValues(t *testing.T) {
	r := newReassembler(t, binaryID)
	input := []byte{1, 2, 3}
	events := mustIngest(t, r, dataeng.Change{
		Relation:  binaryID,
		Operation: dataeng.Insert,
		New: &dataeng.Tuple{Values: []dataeng.Value{
			text("1"), binary(input),
		}},
	})
	input[0] = 99
	if !reflect.DeepEqual(events[0].New.Values[1].Bytes, []byte{1, 2, 3}) {
		t.Fatalf("event row shares bytes with caller input")
	}
}
