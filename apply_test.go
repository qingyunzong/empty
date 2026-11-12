package dataeng_test

import (
	"errors"
	"fmt"
	"sort"
	"testing"

	"example.org/dataeng/q0240"
)

var testSchema = dataeng.Schema{
	PrimaryKey: "ID",
	Columns: []dataeng.Column{
		{ID: "ID", Type: dataeng.TypeInt64},
		{ID: "Name", Type: dataeng.TypeBytes, Nullable: true},
		{ID: "Score", Type: dataeng.TypeInt64},
		{ID: "Note", Type: dataeng.TypeBytes, Nullable: true},
	},
}

func testRow(id int64, name string, score int64, note dataeng.Cell) dataeng.Row {
	return dataeng.Row{
		"ID":    dataeng.Int64Cell(id),
		"Name":  dataeng.BytesCell([]byte(name)),
		"Score": dataeng.Int64Cell(score),
		"Note":  note,
	}
}

func defaultRows() []dataeng.Row {
	return []dataeng.Row{
		testRow(1, "alpha", 10, dataeng.NullCell()),
		testRow(2, "beta", 20, dataeng.BytesCell([]byte("n2"))),
		testRow(3, "gamma", 30, dataeng.NullCell()),
	}
}

func insertRow(id int64, name string, score int64, note dataeng.Cell) dataeng.Row {
	return testRow(id, name, score, note)
}

func mustTable(t *testing.T, schema dataeng.Schema, rows []dataeng.Row) *dataeng.Table {
	t.Helper()
	table, err := dataeng.NewTable(schema, rows)
	if err != nil {
		t.Fatalf("NewTable: %v", err)
	}
	return table
}

func cloneTestRow(row dataeng.Row) dataeng.Row {
	out := make(dataeng.Row, len(row))
	for id, cell := range row {
		out[id] = cell.Clone()
	}
	return out
}

func testKey(cell dataeng.Cell) string {
	switch cell.Kind {
	case dataeng.CellInt64:
		return fmt.Sprintf("i:%d", cell.Int)
	case dataeng.CellBytes:
		return "b:" + string(cell.Bytes)
	default:
		return fmt.Sprintf("invalid:%d", cell.Kind)
	}
}

func testCompare(a, b dataeng.Cell) int {
	if a.Kind != b.Kind {
		return int(a.Kind) - int(b.Kind)
	}
	switch a.Kind {
	case dataeng.CellInt64:
		switch {
		case a.Int < b.Int:
			return -1
		case a.Int > b.Int:
			return 1
		default:
			return 0
		}
	case dataeng.CellBytes:
		switch {
		case string(a.Bytes) < string(b.Bytes):
			return -1
		case string(a.Bytes) > string(b.Bytes):
			return 1
		default:
			return 0
		}
	default:
		return 0
	}
}

// modelFinal builds the final complete table with a deliberately separate,
// straightforward model of the batch semantics. It is not used by the
// production code; tests compare the package result against this model.
func modelFinal(t *testing.T, schema dataeng.Schema, initial []dataeng.Row, ops []dataeng.Operation) []dataeng.Row {
	t.Helper()

	current := make(map[string]dataeng.Row, len(initial))
	for _, row := range initial {
		key := testKey(row[schema.PrimaryKey])
		if _, exists := current[key]; exists {
			t.Fatalf("model: duplicate initial primary key %s", key)
		}
		current[key] = cloneTestRow(row)
	}

	removed := make(map[string]bool)
	for _, op := range ops {
		if op.Kind == dataeng.OpUpdate || op.Kind == dataeng.OpDelete {
			removed[testKey(op.OldID)] = true
		}
	}

	next := make(map[string]dataeng.Row, len(current))
	for key, row := range current {
		if !removed[key] {
			next[key] = cloneTestRow(row)
		}
	}
	for _, op := range ops {
		switch op.Kind {
		case dataeng.OpInsert:
			row := cloneTestRow(op.After)
			key := testKey(row[schema.PrimaryKey])
			if _, exists := next[key]; exists {
				t.Fatalf("model: duplicate published primary key %s", key)
			}
			next[key] = row
		case dataeng.OpUpdate:
			old, ok := current[testKey(op.OldID)]
			if !ok {
				t.Fatalf("model: missing old row %s", testKey(op.OldID))
			}
			merged := cloneTestRow(old)
			for id, cell := range op.After {
				if cell.IsMissing() || cell.IsUnchanged() {
					continue
				}
				merged[id] = cell.Clone()
			}
			key := testKey(merged[schema.PrimaryKey])
			if _, exists := next[key]; exists {
				t.Fatalf("model: duplicate published primary key %s", key)
			}
			next[key] = merged
		case dataeng.OpDelete:
			// Removed before publication.
		default:
			t.Fatalf("model: unknown operation kind %d", op.Kind)
		}
	}

	out := make([]dataeng.Row, 0, len(next))
	for _, row := range next {
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool {
		return testCompare(out[i][schema.PrimaryKey], out[j][schema.PrimaryKey]) < 0
	})
	return out
}

func assertTable(t *testing.T, table *dataeng.Table, schema dataeng.Schema, want []dataeng.Row) {
	t.Helper()
	if got, wantLen := table.Len(), len(want); got != wantLen {
		t.Fatalf("table has %d rows, want %d", got, wantLen)
	}
	for _, wantRow := range want {
		id := wantRow[schema.PrimaryKey]
		got, ok := table.Get(id)
		if !ok {
			t.Fatalf("table is missing primary key %s", id)
		}
		if !got.Equal(wantRow) {
			t.Fatalf("row %s:\n got %v\nwant %v", id, got, wantRow)
		}
	}
	for _, gotRow := range table.Rows() {
		id := gotRow[schema.PrimaryKey]
		found := false
		for _, wantRow := range want {
			if wantRow[schema.PrimaryKey].Equal(id) {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("table has unexpected row %s", id)
		}
	}
}

func changeForID(t *testing.T, changes []dataeng.Change, id dataeng.Cell) dataeng.Change {
	t.Helper()
	for _, change := range changes {
		var actual dataeng.Cell
		switch change.Kind {
		case dataeng.ChangeInsert, dataeng.ChangeUpdate:
			actual = change.NewID
		case dataeng.ChangeDelete:
			actual = change.OldID
		}
		if actual.Equal(id) {
			return change
		}
	}
	t.Fatalf("no change for primary key %s", id)
	return dataeng.Change{}
}

func requireSource(t *testing.T, change dataeng.Change, column string, want dataeng.FieldSource) {
	t.Helper()
	got, ok := change.Source(column)
	if !ok {
		t.Fatalf("%s change for %s has no source for %q", change.Kind, change.NewID, column)
	}
	if got != want {
		t.Fatalf("%s change for %s column %q came from %s, want %s", change.Kind, change.NewID, column, got, want)
	}
}

func TestApplyPartialImagesNullAndProvenance(t *testing.T) {
	initial := defaultRows()
	table := mustTable(t, testSchema, initial)
	initialSnapshot := table.Rows()

	batch := dataeng.NewBatch(
		dataeng.UpdateOp(
			dataeng.Int64Cell(1),
			dataeng.Row{
				"Name":  dataeng.BytesCell([]byte("alpha")),
				"Score": dataeng.Int64Cell(10),
			},
			dataeng.Row{
				"Score": dataeng.Int64Cell(11),
				"Note":  dataeng.BytesCell([]byte("updated")),
			},
		),
		dataeng.UpdateOp(
			dataeng.Int64Cell(2),
			dataeng.Row{
				"Name":  dataeng.BytesCell([]byte("beta")),
				"Score": dataeng.Int64Cell(20),
				"Note":  dataeng.BytesCell([]byte("n2")),
			},
			dataeng.Row{
				"Name": dataeng.NullCell(),
				"Note": dataeng.UnchangedCell(),
			},
		),
		dataeng.DeleteOp(dataeng.Int64Cell(3), dataeng.Row{
			"Name": dataeng.BytesCell([]byte("gamma")),
		}),
		dataeng.InsertOp(insertRow(4, "delta", 40, dataeng.BytesCell([]byte("n4")))),
	)

	result, err := table.Apply(batch)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}

	want := modelFinal(t, testSchema, initial, batch.Operations)
	assertTable(t, result.Table, testSchema, want)

	// The source snapshot must not change even though its rows contain
	// byte-string cells.
	assertTable(t, table, testSchema, initialSnapshot)

	if got, wantLen := len(result.Changes), 4; got != wantLen {
		t.Fatalf("got %d net changes, want %d", got, wantLen)
	}
	if got, wantLen := len(result.Applied), len(batch.Operations); got != wantLen {
		t.Fatalf("got %d applied changes, want %d", got, wantLen)
	}
	if got, wantLen := len(result.Inserted()), 1; got != wantLen {
		t.Fatalf("got %d net inserts, want %d", got, wantLen)
	}
	if got, wantLen := len(result.Updated()), 2; got != wantLen {
		t.Fatalf("got %d net updates, want %d", got, wantLen)
	}
	if got, wantLen := len(result.Deleted()), 1; got != wantLen {
		t.Fatalf("got %d net deletes, want %d", got, wantLen)
	}
	if got := table.PrimaryKey(); got != "ID" {
		t.Fatalf("PrimaryKey() = %q, want ID", got)
	}
	if got := table.Schema().PrimaryKey; got != "ID" {
		t.Fatalf("Schema().PrimaryKey = %q, want ID", got)
	}

	c1 := changeForID(t, result.Changes, dataeng.Int64Cell(1))
	if c1.Kind != dataeng.ChangeUpdate {
		t.Fatalf("row 1 change is %s, want update", c1.Kind)
	}
	requireSource(t, c1, "Name", dataeng.SourceOld)
	requireSource(t, c1, "Score", dataeng.SourceAfter)
	requireSource(t, c1, "Note", dataeng.SourceAfter)

	c2 := changeForID(t, result.Changes, dataeng.Int64Cell(2))
	if c2.Kind != dataeng.ChangeUpdate {
		t.Fatalf("row 2 change is %s, want update", c2.Kind)
	}
	requireSource(t, c2, "Name", dataeng.SourceAfter)
	requireSource(t, c2, "Score", dataeng.SourceOld)
	requireSource(t, c2, "Note", dataeng.SourceOld)
	if !c2.After["Name"].IsNull() {
		t.Fatalf("row 2 Name is %s, want null", c2.After["Name"])
	}

	c3 := changeForID(t, result.Changes, dataeng.Int64Cell(3))
	if c3.Kind != dataeng.ChangeDelete {
		t.Fatalf("row 3 change is %s, want delete", c3.Kind)
	}
	requireSource(t, c3, "Name", dataeng.SourceOld)

	c4 := changeForID(t, result.Changes, dataeng.Int64Cell(4))
	if c4.Kind != dataeng.ChangeInsert {
		t.Fatalf("row 4 change is %s, want insert", c4.Kind)
	}
	requireSource(t, c4, "Name", dataeng.SourceAfter)

	// Applied changes retain input order and the explicit unchanged marker
	// resolves to the old value without becoming an after-image value.
	if !result.Applied[0].OldID.Equal(dataeng.Int64Cell(1)) || !result.Applied[0].NewID.Equal(dataeng.Int64Cell(1)) {
		t.Fatalf("applied[0] ids = %s -> %s", result.Applied[0].OldID, result.Applied[0].NewID)
	}
	if result.Applied[1].After["Note"].Equal(dataeng.BytesCell([]byte("n2"))) == false {
		t.Fatalf("applied[1] Note = %s, want bytes n2", result.Applied[1].After["Note"])
	}
	if got, want := result.Applied[1].Sources["Note"], dataeng.SourceOld; got != want {
		t.Fatalf("applied[1] Note source = %s, want %s", got, want)
	}
}

func TestPrimaryKeySwap(t *testing.T) {
	initial := []dataeng.Row{
		testRow(10, "ten", 100, dataeng.NullCell()),
		testRow(20, "twenty", 200, dataeng.BytesCell([]byte("note20"))),
	}
	table := mustTable(t, testSchema, initial)

	batch := dataeng.NewBatch(
		dataeng.UpdateOp(dataeng.Int64Cell(10), nil, dataeng.Row{
			"ID":   dataeng.Int64Cell(20),
			"Name": dataeng.BytesCell([]byte("ten-moved")),
		}),
		dataeng.UpdateOp(dataeng.Int64Cell(20), nil, dataeng.Row{
			"ID":   dataeng.Int64Cell(10),
			"Name": dataeng.BytesCell([]byte("twenty-moved")),
		}),
	)

	result, err := table.Apply(batch)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	want := modelFinal(t, testSchema, initial, batch.Operations)
	assertTable(t, result.Table, testSchema, want)

	if got, wantLen := len(result.Changes), 2; got != wantLen {
		t.Fatalf("got %d net changes, want %d updates", got, wantLen)
	}
	for _, change := range result.Changes {
		if change.Kind != dataeng.ChangeUpdate {
			t.Fatalf("swap produced %s change for %s, want update", change.Kind, change.NewID)
		}
	}

	if len(result.Applied) != 2 {
		t.Fatalf("got %d applied changes, want 2", len(result.Applied))
	}
	if !result.Applied[0].OldID.Equal(dataeng.Int64Cell(10)) || !result.Applied[0].NewID.Equal(dataeng.Int64Cell(20)) {
		t.Fatalf("applied[0] ids = %s -> %s, want 10 -> 20", result.Applied[0].OldID, result.Applied[0].NewID)
	}
	if !result.Applied[1].OldID.Equal(dataeng.Int64Cell(20)) || !result.Applied[1].NewID.Equal(dataeng.Int64Cell(10)) {
		t.Fatalf("applied[1] ids = %s -> %s, want 20 -> 10", result.Applied[1].OldID, result.Applied[1].NewID)
	}

	got10, _ := result.Table.Get(dataeng.Int64Cell(10))
	if got10["Name"].Equal(dataeng.BytesCell([]byte("twenty-moved"))) == false {
		t.Fatalf("row 10 Name = %s, want twenty-moved", got10["Name"])
	}
	got20, _ := result.Table.Get(dataeng.Int64Cell(20))
	if got20["Name"].Equal(dataeng.BytesCell([]byte("ten-moved"))) == false {
		t.Fatalf("row 20 Name = %s, want ten-moved", got20["Name"])
	}
}

func TestInsertReusesKeyDeletedInSameBatch(t *testing.T) {
	initial := []dataeng.Row{
		testRow(1, "one", 10, dataeng.NullCell()),
		testRow(2, "two", 20, dataeng.NullCell()),
	}
	table := mustTable(t, testSchema, initial)

	batch := dataeng.NewBatch(
		dataeng.DeleteOp(dataeng.Int64Cell(2), nil),
		dataeng.InsertOp(insertRow(2, "replacement", 99, dataeng.BytesCell([]byte("new")))),
	)
	result, err := table.Apply(batch)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	want := modelFinal(t, testSchema, initial, batch.Operations)
	assertTable(t, result.Table, testSchema, want)

	got, _ := result.Table.Get(dataeng.Int64Cell(2))
	if !got["Name"].Equal(dataeng.BytesCell([]byte("replacement"))) {
		t.Fatalf("reused row Name = %s", got["Name"])
	}

	// The net view is keyed by primary key: the key existed both before and
	// after, so this is a net update and all fields come from the insert's
	// after-image.
	change := changeForID(t, result.Changes, dataeng.Int64Cell(2))
	if change.Kind != dataeng.ChangeUpdate {
		t.Fatalf("reused key net change is %s, want update", change.Kind)
	}
	requireSource(t, change, "Name", dataeng.SourceAfter)
	requireSource(t, change, "Score", dataeng.SourceAfter)

	if got, wantLen := len(result.Applied), 2; got != wantLen {
		t.Fatalf("got %d applied changes, want %d", got, wantLen)
	}
	if result.Applied[0].Kind != dataeng.ChangeDelete || result.Applied[1].Kind != dataeng.ChangeInsert {
		t.Fatalf("applied kinds = %s, %s; want delete, insert", result.Applied[0].Kind, result.Applied[1].Kind)
	}
}

func TestUpdateCanMoveIntoKeyDeletedLaterInBatch(t *testing.T) {
	initial := []dataeng.Row{
		testRow(1, "one", 10, dataeng.NullCell()),
		testRow(2, "two", 20, dataeng.BytesCell([]byte("two-note"))),
	}
	table := mustTable(t, testSchema, initial)
	batch := dataeng.NewBatch(
		dataeng.UpdateOp(dataeng.Int64Cell(1), nil, dataeng.Row{
			"ID":   dataeng.Int64Cell(2),
			"Name": dataeng.BytesCell([]byte("moved")),
		}),
		dataeng.DeleteOp(dataeng.Int64Cell(2), nil),
	)
	result, err := table.Apply(batch)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	want := modelFinal(t, testSchema, initial, batch.Operations)
	assertTable(t, result.Table, testSchema, want)

	got, _ := result.Table.Get(dataeng.Int64Cell(2))
	if !got["Name"].Equal(dataeng.BytesCell([]byte("moved"))) {
		t.Fatalf("row 2 Name = %s, want moved", got["Name"])
	}
	if !got["Score"].Equal(dataeng.Int64Cell(10)) {
		t.Fatalf("row 2 Score = %s, want 10", got["Score"])
	}
}

func TestCombinedSwapDeleteAndInsertReuse(t *testing.T) {
	initial := []dataeng.Row{
		testRow(1, "one", 10, dataeng.NullCell()),
		testRow(2, "two", 20, dataeng.NullCell()),
		testRow(3, "three", 30, dataeng.NullCell()),
		testRow(4, "four", 40, dataeng.NullCell()),
	}
	table := mustTable(t, testSchema, initial)
	batch := dataeng.NewBatch(
		dataeng.UpdateOp(dataeng.Int64Cell(1), nil, dataeng.Row{
			"ID":   dataeng.Int64Cell(2),
			"Name": dataeng.BytesCell([]byte("one-now-at-two")),
		}),
		dataeng.UpdateOp(dataeng.Int64Cell(2), nil, dataeng.Row{
			"ID":   dataeng.Int64Cell(1),
			"Name": dataeng.BytesCell([]byte("two-now-at-one")),
		}),
		dataeng.DeleteOp(dataeng.Int64Cell(3), nil),
		dataeng.InsertOp(insertRow(3, "three-replacement", 33, dataeng.BytesCell([]byte("new")))),
		dataeng.DeleteOp(dataeng.Int64Cell(4), nil),
	)

	result, err := table.Apply(batch)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	want := modelFinal(t, testSchema, initial, batch.Operations)
	assertTable(t, result.Table, testSchema, want)

	// Keys 1 and 2 are swapped; key 3 is reused by the insert; key 4 is gone.
	if result.Table.Len() != 3 {
		t.Fatalf("table has %d rows, want 3", result.Table.Len())
	}
	row1, _ := result.Table.Get(dataeng.Int64Cell(1))
	if !row1["Name"].Equal(dataeng.BytesCell([]byte("two-now-at-one"))) {
		t.Fatalf("row 1 Name = %s", row1["Name"])
	}
	row2, _ := result.Table.Get(dataeng.Int64Cell(2))
	if !row2["Name"].Equal(dataeng.BytesCell([]byte("one-now-at-two"))) {
		t.Fatalf("row 2 Name = %s", row2["Name"])
	}
	row3, _ := result.Table.Get(dataeng.Int64Cell(3))
	if !row3["Name"].Equal(dataeng.BytesCell([]byte("three-replacement"))) {
		t.Fatalf("row 3 Name = %s", row3["Name"])
	}
	if _, ok := result.Table.Get(dataeng.Int64Cell(4)); ok {
		t.Fatal("row 4 was not deleted")
	}
}

func TestNoOpUpdateIsAppliedButNotNetChange(t *testing.T) {
	initial := []dataeng.Row{testRow(1, "one", 10, dataeng.NullCell())}
	table := mustTable(t, testSchema, initial)

	batch := dataeng.NewBatch(dataeng.UpdateOp(dataeng.Int64Cell(1), nil, dataeng.Row{
		"Name": dataeng.UnchangedCell(),
	}))
	result, err := table.Apply(batch)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if len(result.Changes) != 0 {
		t.Fatalf("no-op update produced %d net changes, want 0", len(result.Changes))
	}
	if len(result.Applied) != 1 {
		t.Fatalf("no-op update produced %d applied changes, want 1", len(result.Applied))
	}
	assertTable(t, result.Table, testSchema, initial)
}

func TestBatchFailuresRollBackAndLeaveSnapshotUntouched(t *testing.T) {
	fullRow := func(id int64) dataeng.Row {
		return insertRow(id, "full", id, dataeng.BytesCell([]byte("note")))
	}

	cases := []struct {
		name    string
		initial []dataeng.Row
		ops     []dataeng.Operation
		wantErr error
	}{
		{
			name:    "same old row updated twice",
			ops:     []dataeng.Operation{dataeng.UpdateOp(dataeng.Int64Cell(1), nil, dataeng.Row{"Score": dataeng.Int64Cell(11)}), dataeng.UpdateOp(dataeng.Int64Cell(1), nil, dataeng.Row{"Name": dataeng.NullCell()})},
			wantErr: dataeng.ErrConflict,
		},
		{
			name:    "same old row updated then deleted",
			ops:     []dataeng.Operation{dataeng.UpdateOp(dataeng.Int64Cell(1), nil, nil), dataeng.DeleteOp(dataeng.Int64Cell(1), nil)},
			wantErr: dataeng.ErrConflict,
		},
		{
			name:    "update to retained key",
			ops:     []dataeng.Operation{dataeng.UpdateOp(dataeng.Int64Cell(1), nil, dataeng.Row{"ID": dataeng.Int64Cell(2)})},
			wantErr: dataeng.ErrConflict,
		},
		{
			name:    "insert over retained key",
			ops:     []dataeng.Operation{dataeng.InsertOp(fullRow(1))},
			wantErr: dataeng.ErrConflict,
		},
		{
			name:    "two inserts publish same key",
			ops:     []dataeng.Operation{dataeng.InsertOp(fullRow(9)), dataeng.InsertOp(fullRow(9))},
			wantErr: dataeng.ErrConflict,
		},
		{
			name:    "two updates publish same key",
			ops:     []dataeng.Operation{dataeng.UpdateOp(dataeng.Int64Cell(1), nil, dataeng.Row{"ID": dataeng.Int64Cell(9)}), dataeng.UpdateOp(dataeng.Int64Cell(2), nil, dataeng.Row{"ID": dataeng.Int64Cell(9)})},
			wantErr: dataeng.ErrConflict,
		},
		{
			name:    "update and insert publish same key",
			ops:     []dataeng.Operation{dataeng.UpdateOp(dataeng.Int64Cell(1), nil, dataeng.Row{"ID": dataeng.Int64Cell(9)}), dataeng.InsertOp(fullRow(9))},
			wantErr: dataeng.ErrConflict,
		},
		{
			name:    "unknown update after column",
			ops:     []dataeng.Operation{dataeng.UpdateOp(dataeng.Int64Cell(1), nil, dataeng.Row{"Unknown": dataeng.Int64Cell(1)})},
			wantErr: dataeng.ErrInvalidBatch,
		},
		{
			name:    "unknown before column",
			ops:     []dataeng.Operation{dataeng.UpdateOp(dataeng.Int64Cell(1), dataeng.Row{"Unknown": dataeng.Int64Cell(1)}, nil)},
			wantErr: dataeng.ErrInvalidBatch,
		},
		{
			name:    "bad before value",
			ops:     []dataeng.Operation{dataeng.UpdateOp(dataeng.Int64Cell(1), dataeng.Row{"Score": dataeng.Int64Cell(99)}, nil)},
			wantErr: dataeng.ErrBadBefore,
		},
		{
			name:    "before contains unchanged",
			ops:     []dataeng.Operation{dataeng.UpdateOp(dataeng.Int64Cell(1), dataeng.Row{"Score": dataeng.UnchangedCell()}, nil)},
			wantErr: dataeng.ErrInvalidBatch,
		},
		{
			name:    "wrong after type",
			ops:     []dataeng.Operation{dataeng.UpdateOp(dataeng.Int64Cell(1), nil, dataeng.Row{"Score": dataeng.BytesCell([]byte("bad"))})},
			wantErr: dataeng.ErrInvalidBatch,
		},
		{
			name:    "null in non-nullable update column",
			ops:     []dataeng.Operation{dataeng.UpdateOp(dataeng.Int64Cell(1), nil, dataeng.Row{"Score": dataeng.NullCell()})},
			wantErr: dataeng.ErrInvalidBatch,
		},
		{
			name:    "insert missing column",
			ops:     []dataeng.Operation{dataeng.InsertOp(dataeng.Row{"ID": dataeng.Int64Cell(9), "Score": dataeng.Int64Cell(90)})},
			wantErr: dataeng.ErrInvalidBatch,
		},
		{
			name: "insert contains unchanged",
			ops: []dataeng.Operation{dataeng.InsertOp(dataeng.Row{
				"ID": dataeng.Int64Cell(9), "Name": dataeng.BytesCell([]byte("x")),
				"Score": dataeng.Int64Cell(90), "Note": dataeng.UnchangedCell(),
			})},
			wantErr: dataeng.ErrInvalidBatch,
		},
		{
			name: "insert contains missing cell",
			ops: []dataeng.Operation{dataeng.InsertOp(dataeng.Row{
				"ID": dataeng.Int64Cell(9), "Name": dataeng.MissingCell(),
				"Score": dataeng.Int64Cell(90), "Note": dataeng.NullCell(),
			})},
			wantErr: dataeng.ErrInvalidBatch,
		},
		{
			name: "insert null into non-nullable column",
			ops: []dataeng.Operation{dataeng.InsertOp(dataeng.Row{
				"ID": dataeng.Int64Cell(9), "Name": dataeng.NullCell(),
				"Score": dataeng.NullCell(), "Note": dataeng.NullCell(),
			})},
			wantErr: dataeng.ErrInvalidBatch,
		},
		{
			name:    "missing old row",
			ops:     []dataeng.Operation{dataeng.UpdateOp(dataeng.Int64Cell(99), nil, nil)},
			wantErr: dataeng.ErrMissingRow,
		},
		{
			name:    "old id wrong type",
			ops:     []dataeng.Operation{dataeng.UpdateOp(dataeng.BytesCell([]byte("1")), nil, nil)},
			wantErr: dataeng.ErrInvalidBatch,
		},
		{
			name:    "old id null",
			ops:     []dataeng.Operation{dataeng.UpdateOp(dataeng.NullCell(), nil, nil)},
			wantErr: dataeng.ErrInvalidBatch,
		},
		{
			name:    "delete carries after image",
			ops:     []dataeng.Operation{{Kind: dataeng.OpDelete, OldID: dataeng.Int64Cell(1), After: dataeng.Row{"Score": dataeng.Int64Cell(1)}}},
			wantErr: dataeng.ErrInvalidBatch,
		},
		{
			name:    "insert carries before image",
			ops:     []dataeng.Operation{{Kind: dataeng.OpInsert, Before: dataeng.Row{"Score": dataeng.Int64Cell(10)}, After: fullRow(9)}},
			wantErr: dataeng.ErrInvalidBatch,
		},
		{
			name:    "insert carries old id",
			ops:     []dataeng.Operation{{Kind: dataeng.OpInsert, OldID: dataeng.Int64Cell(1), After: fullRow(9)}},
			wantErr: dataeng.ErrInvalidBatch,
		},
		{
			name:    "unknown operation kind",
			ops:     []dataeng.Operation{{Kind: dataeng.OpKind(99), After: fullRow(9)}},
			wantErr: dataeng.ErrInvalidBatch,
		},
		{
			name:    "unknown cell kind in update",
			ops:     []dataeng.Operation{dataeng.UpdateOp(dataeng.Int64Cell(1), nil, dataeng.Row{"Score": {Kind: dataeng.CellKind(99)}})},
			wantErr: dataeng.ErrInvalidBatch,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			initial := tc.initial
			if initial == nil {
				initial = defaultRows()
			}
			table := mustTable(t, testSchema, initial)
			snapshot := table.Rows()

			result, err := table.Apply(dataeng.NewBatch(tc.ops...))
			if err == nil {
				t.Fatalf("Apply succeeded, want error %v", tc.wantErr)
			}
			if tc.wantErr != nil && !errors.Is(err, tc.wantErr) {
				t.Fatalf("Apply error = %v, want errors.Is(%v)", err, tc.wantErr)
			}
			if result != nil {
				t.Fatalf("Apply returned a result along with error %v", err)
			}
			assertTable(t, table, testSchema, snapshot)
		})
	}
}

func TestEmptyBatchProducesEqualIndependentSnapshot(t *testing.T) {
	initial := defaultRows()
	table := mustTable(t, testSchema, initial)
	result, err := table.ApplyOperations(nil)
	if err != nil {
		t.Fatalf("Apply empty batch: %v", err)
	}
	if result.Table == table {
		t.Fatal("empty batch returned the same Table pointer")
	}
	if len(result.Changes) != 0 || len(result.Applied) != 0 {
		t.Fatalf("empty batch produced %d net and %d applied changes", len(result.Changes), len(result.Applied))
	}
	assertTable(t, result.Table, testSchema, initial)
	assertTable(t, table, testSchema, initial)
}

func TestBytesPrimaryKeyAndInsertDelete(t *testing.T) {
	schema := dataeng.Schema{
		PrimaryKey: "Key",
		Columns: []dataeng.Column{
			{ID: "Key", Type: dataeng.TypeBytes},
			{ID: "Value", Type: dataeng.TypeInt64, Nullable: true},
		},
	}
	initial := []dataeng.Row{
		{"Key": dataeng.BytesCell([]byte("a")), "Value": dataeng.Int64Cell(1)},
		{"Key": dataeng.BytesCell([]byte("b")), "Value": dataeng.Int64Cell(2)},
	}
	table := mustTable(t, schema, initial)

	keyA := dataeng.BytesCell([]byte("a"))
	keyB := dataeng.BytesCell([]byte("b"))
	batch := dataeng.NewBatch(
		dataeng.UpdateOp(keyA, dataeng.Row{"Key": dataeng.BytesCell([]byte("a"))}, dataeng.Row{"Key": dataeng.BytesCell([]byte("c"))}),
		dataeng.DeleteOp(keyB, nil),
		dataeng.InsertOp(dataeng.Row{"Key": dataeng.BytesCell([]byte("d")), "Value": dataeng.NullCell()}),
	)
	result, err := table.Apply(batch)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	want := modelFinal(t, schema, initial, batch.Operations)
	assertTable(t, result.Table, schema, want)

	got, ok := result.Table.Get(dataeng.BytesCell([]byte("c")))
	if !ok {
		t.Fatal("moved byte-string primary key c not found")
	}
	if !got["Value"].Equal(dataeng.Int64Cell(1)) {
		t.Fatalf("row c Value = %s, want 1", got["Value"])
	}
	if _, ok := result.Table.Get(keyA); ok {
		t.Fatal("old byte-string primary key a still present")
	}
}

func TestSnapshotValidation(t *testing.T) {
	validSchema := testSchema
	goodRows := []dataeng.Row{testRow(1, "one", 10, dataeng.NullCell())}

	schemaCases := []struct {
		name    string
		schema  dataeng.Schema
		wantErr error
	}{
		{
			name: "empty primary key",
			schema: dataeng.Schema{
				Columns: []dataeng.Column{{ID: "ID", Type: dataeng.TypeInt64}},
			},
			wantErr: dataeng.ErrInvalidSchema,
		},
		{
			name: "missing primary key column",
			schema: dataeng.Schema{
				PrimaryKey: "Missing",
				Columns:    []dataeng.Column{{ID: "ID", Type: dataeng.TypeInt64}},
			},
			wantErr: dataeng.ErrInvalidSchema,
		},
		{
			name: "nullable primary key",
			schema: dataeng.Schema{
				PrimaryKey: "ID",
				Columns:    []dataeng.Column{{ID: "ID", Type: dataeng.TypeInt64, Nullable: true}},
			},
			wantErr: dataeng.ErrInvalidSchema,
		},
		{
			name: "duplicate column",
			schema: dataeng.Schema{
				PrimaryKey: "ID",
				Columns: []dataeng.Column{
					{ID: "ID", Type: dataeng.TypeInt64},
					{ID: "ID", Type: dataeng.TypeInt64},
				},
			},
			wantErr: dataeng.ErrInvalidSchema,
		},
		{
			name: "invalid column type",
			schema: dataeng.Schema{
				PrimaryKey: "ID",
				Columns:    []dataeng.Column{{ID: "ID", Type: dataeng.ColumnType(0)}},
			},
			wantErr: dataeng.ErrInvalidSchema,
		},
		{
			name:    "no columns",
			schema:  dataeng.Schema{PrimaryKey: "ID"},
			wantErr: dataeng.ErrInvalidSchema,
		},
	}
	for _, tc := range schemaCases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := dataeng.NewTable(tc.schema, goodRows); !errors.Is(err, tc.wantErr) {
				t.Fatalf("NewTable error = %v, want %v", err, tc.wantErr)
			}
		})
	}

	if schema, err := dataeng.NewSchema("ID", validSchema.Columns); err != nil {
		t.Fatalf("NewSchema: %v", err)
	} else {
		if schema.PrimaryKey != "ID" {
			t.Fatalf("NewSchema primary key = %q, want ID", schema.PrimaryKey)
		}
		cloned := schema.Clone()
		if err := cloned.Validate(); err != nil {
			t.Fatalf("cloned NewSchema is invalid: %v", err)
		}
	}

	rowCases := []struct {
		name    string
		rows    []dataeng.Row
		wantErr error
	}{
		{
			name:    "duplicate primary keys",
			rows:    []dataeng.Row{testRow(1, "a", 1, dataeng.NullCell()), testRow(1, "b", 2, dataeng.NullCell())},
			wantErr: dataeng.ErrInvalidRow,
		},
		{
			name:    "unknown column",
			rows:    []dataeng.Row{{"ID": dataeng.Int64Cell(1), "Name": dataeng.NullCell(), "Score": dataeng.Int64Cell(1), "Note": dataeng.NullCell(), "Unknown": dataeng.Int64Cell(1)}},
			wantErr: dataeng.ErrInvalidRow,
		},
		{
			name:    "missing column",
			rows:    []dataeng.Row{{"ID": dataeng.Int64Cell(1), "Name": dataeng.NullCell(), "Score": dataeng.Int64Cell(1)}},
			wantErr: dataeng.ErrInvalidRow,
		},
		{
			name:    "unchanged cell in snapshot",
			rows:    []dataeng.Row{{"ID": dataeng.Int64Cell(1), "Name": dataeng.UnchangedCell(), "Score": dataeng.Int64Cell(1), "Note": dataeng.NullCell()}},
			wantErr: dataeng.ErrInvalidRow,
		},
		{
			name:    "null in non-nullable column",
			rows:    []dataeng.Row{{"ID": dataeng.Int64Cell(1), "Name": dataeng.NullCell(), "Score": dataeng.NullCell(), "Note": dataeng.NullCell()}},
			wantErr: dataeng.ErrInvalidRow,
		},
		{
			name:    "wrong column type",
			rows:    []dataeng.Row{{"ID": dataeng.Int64Cell(1), "Name": dataeng.Int64Cell(1), "Score": dataeng.Int64Cell(1), "Note": dataeng.NullCell()}},
			wantErr: dataeng.ErrInvalidRow,
		},
		{
			name:    "null primary key",
			rows:    []dataeng.Row{{"ID": dataeng.NullCell(), "Name": dataeng.NullCell(), "Score": dataeng.Int64Cell(1), "Note": dataeng.NullCell()}},
			wantErr: dataeng.ErrInvalidRow,
		},
	}
	for _, tc := range rowCases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := dataeng.NewTable(validSchema, tc.rows); !errors.Is(err, tc.wantErr) {
				t.Fatalf("NewTable error = %v, want %v", err, tc.wantErr)
			}
		})
	}
}

func TestCellMissingUnchangedAndNullAreDistinct(t *testing.T) {
	missing := dataeng.MissingCell()
	unchanged := dataeng.UnchangedCell()
	null := dataeng.NullCell()
	zero := dataeng.Cell{}

	if !zero.Equal(missing) {
		t.Fatal("zero Cell should equal MissingCell")
	}
	if missing.Equal(null) || unchanged.Equal(null) || missing.Equal(unchanged) {
		t.Fatal("missing, unchanged and null must be distinct cells")
	}
	if missing.IsConcrete() || unchanged.IsConcrete() || !null.IsConcrete() {
		t.Fatal("concrete classification is wrong")
	}

	raw := []byte("abc")
	cell := dataeng.BytesCell(raw)
	raw[0] = 'z'
	if !cell.Equal(dataeng.BytesCell([]byte("abc"))) {
		t.Fatal("BytesCell did not copy its input")
	}
	got, ok := cell.AsBytes()
	if !ok {
		t.Fatal("AsBytes reported no value")
	}
	got[0] = 'q'
	if !cell.Equal(dataeng.BytesCell([]byte("abc"))) {
		t.Fatal("AsBytes did not return a copy")
	}
	if value, ok := dataeng.Int64Cell(42).AsInt64(); !ok || value != 42 {
		t.Fatalf("AsInt64 = (%d, %v), want (42, true)", value, ok)
	}
}
