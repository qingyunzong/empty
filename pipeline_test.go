package dataeng

import (
	"errors"
	"math"
	"reflect"
	"testing"
)

func testTableMap(tableID uint64, extra ...Column) TableMap {
	columns := []Column{
		{Name: "id", Type: TypeBigInt, Unsigned: true},
		{Name: "name", Type: TypeVarChar},
		{Name: "qty", Type: TypeInt, Unsigned: true},
		{Name: "doc", Type: TypeJSON, PartialJSON: true},
	}
	columns = append(columns, extra...)
	return NewTableMap(tableID, "shop", "items", columns, "id")
}

func TestMinimalRowImageIsCompletedFromVersionedPreImage(t *testing.T) {
	p := NewPipeline()
	if err := p.ApplyTableMap(testTableMap(7)); err != nil {
		t.Fatal(err)
	}

	insert, err := p.NormalizeRow(RowEvent{
		Type:    RowInsert,
		TableID: 7,
		After: RowImage{
			"id":   uint64(1),
			"name": "first",
			"qty":  uint64(3),
			"doc":  map[string]any{"a": float64(1)},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !insert.Reconstructable || len(insert.MissingColumns) != 0 {
		t.Fatalf("insert not complete: %+v", insert)
	}
	if insert.Generation != 1 || insert.Version == 0 {
		t.Fatalf("unexpected generation/version: %d/%d", insert.Generation, insert.Version)
	}

	update, err := p.NormalizeRow(RowEvent{
		Type:    RowUpdate,
		TableID: 7,
		Before:  RowImage{"id": uint64(1)},
		After:   RowImage{"name": "second"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !update.Reconstructable {
		t.Fatalf("update should be reconstructable: %+v", update)
	}
	if update.Row["name"] != "second" || update.Row["qty"] != uint64(3) {
		t.Fatalf("unexpected row: %#v", update.Row)
	}
	if _, ok := update.Row["doc"]; !ok {
		t.Fatalf("json column was lost: %#v", update.Row)
	}
	if update.BaseVersion != insert.Version {
		t.Fatalf("base version = %d, want %d", update.BaseVersion, insert.Version)
	}
}

func TestMissingPreImageMarksNotReconstructableAndDoesNotZeroFill(t *testing.T) {
	p := NewPipeline()
	if err := p.ApplyTableMap(testTableMap(7)); err != nil {
		t.Fatal(err)
	}

	row, err := p.NormalizeRow(RowEvent{
		Type:    RowUpdate,
		TableID: 7,
		Before:  RowImage{"id": uint64(99)},
		After:   RowImage{"name": "unknown"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if row.Reconstructable || row.Complete || row.Rebuildable {
		t.Fatalf("row must be marked not reconstructable: %+v", row)
	}
	if len(row.MissingColumns) != 2 || !contains(row.MissingColumns, "qty") || !contains(row.MissingColumns, "doc") {
		t.Fatalf("unexpected missing columns: %v", row.MissingColumns)
	}
	for _, missing := range row.MissingColumns {
		if value, ok := row.Row[missing]; ok {
			t.Fatalf("missing column %q was zero-filled with %#v", missing, value)
		}
	}
	if row.Row["id"] != uint64(99) || row.Row["name"] != "unknown" {
		t.Fatalf("known values were not preserved: %#v", row.Row)
	}
}

func TestNullIsPresentAndNotTreatedAsMissing(t *testing.T) {
	p := NewPipeline()
	if err := p.ApplyTableMap(testTableMap(7)); err != nil {
		t.Fatal(err)
	}
	insert, err := p.NormalizeRow(RowEvent{
		Type:    RowInsert,
		TableID: 7,
		After: RowImage{
			"id":   uint64(1),
			"name": nil,
			"qty":  uint64(0),
			"doc":  nil,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !insert.Reconstructable || len(insert.MissingColumns) != 0 {
		t.Fatalf("NULL should count as present: %+v", insert)
	}
	if value, ok := insert.Row["name"]; !ok || value != nil {
		t.Fatalf("NULL was not preserved: %#v", insert.Row)
	}
}

func TestUnsignedValuesAreReinterpretedAtColumnWidth(t *testing.T) {
	tests := []struct {
		name   string
		column Column
		value  any
		want   any
	}{
		{"tinyint", Column{Name: "v", Type: TypeTinyInt, Unsigned: true}, int64(-1), uint64(255)},
		{"smallint", Column{Name: "v", Type: TypeSmallInt, Unsigned: true}, int64(-2), uint64(65534)},
		{"mediumint", Column{Name: "v", Type: TypeMediumInt, Unsigned: true}, int64(-1), uint64(16777215)},
		{"int", Column{Name: "v", Type: TypeInt, Unsigned: true}, int64(-2), uint64(math.MaxUint32 - 1)},
		{"bigint", Column{Name: "v", Type: TypeBigInt, Unsigned: true}, int64(-1), uint64(math.MaxUint64)},
		{"bigint positive", Column{Name: "v", Type: TypeBigInt, Unsigned: true}, int64(42), uint64(42)},
		{"signed", Column{Name: "v", Type: TypeInt}, int32(-2), int64(-2)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := NormalizeValue(test.column, test.value)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("got %#v (%T), want %#v (%T)", got, got, test.want, test.want)
			}
		})
	}
}

func TestPrimaryKeyChangeMovesVersionedImage(t *testing.T) {
	p := NewPipeline()
	if err := p.ApplyTableMap(testTableMap(7)); err != nil {
		t.Fatal(err)
	}
	_, err := p.NormalizeRow(RowEvent{
		Type:    RowInsert,
		TableID: 7,
		After: RowImage{
			"id":   uint64(1),
			"name": "one",
			"qty":  uint64(1),
			"doc":  map[string]any{},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	update, err := p.NormalizeRow(RowEvent{
		Type:    RowUpdate,
		TableID: 7,
		Before:  RowImage{"id": uint64(1)},
		After:   RowImage{"id": uint64(2), "name": "two"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !update.Reconstructable || update.Row["id"] != uint64(2) {
		t.Fatalf("unexpected primary-key update: %+v", update)
	}
	old, ok := p.Store.Get("shop", "items", 1, mustKey(t, testTableMap(7), RowImage{"id": uint64(1)}))
	if ok {
		t.Fatalf("old key image still exists: %+v", old)
	}
	next, err := p.NormalizeRow(RowEvent{
		Type:    RowUpdate,
		TableID: 7,
		Before:  RowImage{"id": uint64(2)},
		After:   RowImage{"qty": uint64(9)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !next.Reconstructable || next.Row["name"] != "two" || next.Row["qty"] != uint64(9) {
		t.Fatalf("new key was not stored correctly: %+v", next)
	}
}

func mustKey(t *testing.T, tm TableMap, image RowImage) string {
	t.Helper()
	key, _, missing := RowKey(tm, image)
	if len(missing) > 0 {
		t.Fatalf("missing key columns: %v", missing)
	}
	return key
}

func TestDDLImmediatelyInvalidatesTableMapAndPreImages(t *testing.T) {
	p := NewPipeline()
	if err := p.ApplyTableMap(testTableMap(7)); err != nil {
		t.Fatal(err)
	}
	_, err := p.NormalizeRow(RowEvent{
		Type:    RowInsert,
		TableID: 7,
		After: RowImage{
			"id":   uint64(1),
			"name": "one",
			"qty":  uint64(1),
			"doc":  map[string]any{},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := p.ApplyDDL(DDLEvent{Kind: DDLAlter, Schema: "shop", Table: "items"}); err != nil {
		t.Fatal(err)
	}

	_, err = p.NormalizeRow(RowEvent{
		Type:    RowUpdate,
		TableID: 7,
		Before:  RowImage{"id": uint64(1)},
		After:   RowImage{"name": "stale"},
	})
	if !errors.Is(err, ErrStaleTableMap) {
		t.Fatalf("expected stale table map error, got %v", err)
	}
	if p.Store.Len() != 0 {
		t.Fatalf("DDL did not clear pre-images: %d", p.Store.Len())
	}

	newMap := testTableMap(8, Column{Name: "added", Type: TypeVarChar})
	if err := p.ApplyTableMap(newMap); err != nil {
		t.Fatal(err)
	}
	if got := p.Registry.Generation("shop", "items"); got != 2 {
		t.Fatalf("generation after DDL = %d, want 2", got)
	}

	row, err := p.NormalizeRow(RowEvent{
		Type:    RowInsert,
		TableID: 8,
		After: RowImage{
			"id":   uint64(2),
			"name": "two",
			"qty":  uint64(2),
			"doc":  map[string]any{},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if row.Reconstructable {
		t.Fatalf("old columns must not complete a row after DDL: %+v", row)
	}
	if len(row.MissingColumns) != 1 || row.MissingColumns[0] != "added" {
		t.Fatalf("unexpected missing columns after DDL: %v", row.MissingColumns)
	}
}

func TestTableMapGenerationChangesOnlyWhenLayoutChanges(t *testing.T) {
	p := NewPipeline()
	tm := testTableMap(7)
	if err := p.ApplyTableMap(tm); err != nil {
		t.Fatal(err)
	}
	if got := p.Registry.Generation("shop", "items"); got != 1 {
		t.Fatalf("generation = %d, want 1", got)
	}
	if err := p.ApplyTableMap(tm); err != nil {
		t.Fatal(err)
	}
	if got := p.Registry.Generation("shop", "items"); got != 1 {
		t.Fatalf("duplicate TABLE_MAP changed generation: %d", got)
	}
	changed := testTableMap(8, Column{Name: "extra", Type: TypeText})
	if err := p.ApplyTableMap(changed); err != nil {
		t.Fatal(err)
	}
	if got := p.Registry.Generation("shop", "items"); got != 2 {
		t.Fatalf("layout change generation = %d, want 2", got)
	}
	if _, err := p.Registry.Resolve(7); err != nil {
		t.Fatalf("old table id should still resolve until it is reclaimed: %v", err)
	}
}

func TestTransactionPayloadAppliesEventsInOrder(t *testing.T) {
	p := NewPipeline()
	tx := Transaction{
		GTID: "gtid-1",
		Events: []Event{
			testTableMap(7),
			RowEvent{
				Type:    RowInsert,
				TableID: 7,
				After: RowImage{
					"id":   uint64(1),
					"name": "one",
					"qty":  uint64(1),
					"doc":  map[string]any{"a": float64(1)},
				},
			},
			RowEvent{
				Type:    RowUpdate,
				TableID: 7,
				Before:  RowImage{"id": uint64(1)},
				After:   RowImage{"name": "two"},
			},
			DDLEvent{Kind: DDLAlter, Schema: "shop", Table: "items"},
			RowEvent{
				Type:    RowUpdate,
				TableID: 7,
				Before:  RowImage{"id": uint64(1)},
				After:   RowImage{"name": "stale"},
			},
		},
	}

	result, err := p.ProcessTransaction(tx)
	if !errors.Is(err, ErrStaleTableMap) {
		t.Fatalf("expected stale error, got %v", err)
	}
	if result.GTID != "gtid-1" || len(result.Rows) != 2 || len(result.TableMaps) != 1 || len(result.DDLs) != 1 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if !result.Rows[1].Reconstructable || result.Rows[1].Row["name"] != "two" {
		t.Fatalf("transaction row was not normalized: %+v", result.Rows[1])
	}
	if result.Complete() {
		t.Fatalf("transaction with an error must not be complete")
	}
}

func TestDDLWithoutSchemaStillInvalidatesMatchingTable(t *testing.T) {
	p := NewPipeline()
	if err := p.ApplyTableMap(testTableMap(7)); err != nil {
		t.Fatal(err)
	}
	if err := p.ApplyDDL(DDLEvent{Kind: DDLAlter, Table: "items"}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Registry.Resolve(7); !errors.Is(err, ErrStaleTableMap) {
		t.Fatalf("schema-less DDL did not invalidate table map: %v", err)
	}
}

func TestParseDDL(t *testing.T) {
	tests := []struct {
		query  string
		kind   DDLKind
		schema string
		table  string
	}{
		{"ALTER TABLE `shop`.`items` ADD COLUMN x INT", DDLAlter, "shop", "items"},
		{"DROP TABLE IF EXISTS items", DDLDrop, "", "items"},
		{"TRUNCATE TABLE shop.items", DDLTruncate, "shop", "items"},
		{"RENAME TABLE shop.items TO shop.items2", DDLRename, "shop", "items"},
	}
	for _, test := range tests {
		t.Run(test.kind.String(), func(t *testing.T) {
			event := ParseDDL(test.query)
			if event.Kind != test.kind || event.Schema != test.schema || event.Table != test.table {
				t.Fatalf("ParseDDL(%q) = %+v", test.query, event)
			}
		})
	}
}

func TestTransactionConvenienceSlices(t *testing.T) {
	p := NewPipeline()
	result, err := p.ProcessTransaction(Transaction{
		TableMaps: []TableMap{testTableMap(7)},
		Rows: []RowEvent{{
			Type:    RowInsert,
			TableID: 7,
			After: RowImage{
				"id":   uint64(1),
				"name": "one",
				"qty":  uint64(1),
				"doc":  map[string]any{},
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.TableMaps) != 1 || len(result.Rows) != 1 || !result.AllReconstructable {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestInsertMissingColumnsAreNotZeroFilled(t *testing.T) {
	p := NewPipeline()
	if err := p.ApplyTableMap(testTableMap(7)); err != nil {
		t.Fatal(err)
	}
	row, err := p.NormalizeRow(RowEvent{
		Type:    RowInsert,
		TableID: 7,
		After:   RowImage{"id": uint64(1), "name": "partial"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if row.Reconstructable || !contains(row.MissingColumns, "qty") || !contains(row.MissingColumns, "doc") {
		t.Fatalf("unexpected insert result: %+v", row)
	}
	if _, ok := row.Row["qty"]; ok {
		t.Fatalf("missing qty was zero-filled: %#v", row.Row)
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
