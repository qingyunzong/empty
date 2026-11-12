package dataeng

import (
	"fmt"
	"sort"
)

// Table is an immutable snapshot of complete rows.
//
// The zero value is not usable; construct a table with NewTable.
type Table struct {
	schema Schema
	rows   map[string]Row
}

// NewTable validates schema and rows and returns an independent snapshot.
// Every row must contain all columns, every primary key must be unique, and no
// row may contain CellMissing or CellUnchanged.
func NewTable(schema Schema, rows []Row) (*Table, error) {
	s := schema.Clone()
	if err := s.Validate(); err != nil {
		return nil, err
	}

	cols := s.columnMap()
	table := &Table{
		schema: s,
		rows:   make(map[string]Row, len(rows)),
	}
	for i, row := range rows {
		clean, err := validateCompleteRow(s, cols, row, fmt.Sprintf("row %d", i))
		if err != nil {
			return nil, err
		}
		id := clean[s.PrimaryKey]
		key := id.canonicalKey()
		if _, exists := table.rows[key]; exists {
			return nil, fmt.Errorf("%w: row %d repeats primary key %s", ErrInvalidRow, i, id)
		}
		table.rows[key] = clean
	}
	return table, nil
}

// NewTableRows is a variadic convenience wrapper around NewTable.
func NewTableRows(schema Schema, rows ...Row) (*Table, error) {
	return NewTable(schema, rows)
}

// Schema returns a copy of the table's schema.
func (t *Table) Schema() Schema {
	if t == nil {
		return Schema{}
	}
	return t.schema.Clone()
}

// PrimaryKey returns the primary-key column ID.
func (t *Table) PrimaryKey() string {
	if t == nil {
		return ""
	}
	return t.schema.PrimaryKey
}

// Len returns the number of rows in the snapshot.
func (t *Table) Len() int {
	if t == nil {
		return 0
	}
	return len(t.rows)
}

// Get returns a copy of the row with the given primary-key value.
func (t *Table) Get(id Cell) (Row, bool) {
	if t == nil {
		return nil, false
	}
	row, ok := t.rows[id.canonicalKey()]
	if !ok {
		return nil, false
	}
	return cloneRow(row), true
}

// Lookup is an alias for Get.
func (t *Table) Lookup(id Cell) (Row, bool) {
	return t.Get(id)
}

// Rows returns deep copies of all rows ordered by primary key. Int64 keys are
// ordered numerically and byte-string keys lexicographically.
func (t *Table) Rows() []Row {
	if t == nil {
		return nil
	}
	type entry struct {
		id  Cell
		row Row
	}
	entries := make([]entry, 0, len(t.rows))
	for _, row := range t.rows {
		entries = append(entries, entry{id: row[t.schema.PrimaryKey], row: row})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		return compareCells(entries[i].id, entries[j].id) < 0
	})
	out := make([]Row, len(entries))
	for i, e := range entries {
		out[i] = cloneRow(e.row)
	}
	return out
}

// Clone returns an independent copy of the snapshot.
func (t *Table) Clone() *Table {
	if t == nil {
		return nil
	}
	out := &Table{
		schema: t.schema.Clone(),
		rows:   make(map[string]Row, len(t.rows)),
	}
	for key, row := range t.rows {
		out.rows[key] = cloneRow(row)
	}
	return out
}

// validateCompleteRow checks that row has exactly the schema's columns with
// concrete, correctly typed values, and returns a deep copy.
func validateCompleteRow(schema Schema, cols map[string]Column, row Row, context string) (Row, error) {
	for id := range row {
		if _, ok := cols[id]; !ok {
			return nil, fmt.Errorf("%w: %s: unknown column %q", ErrInvalidRow, context, id)
		}
	}
	out := make(Row, len(schema.Columns))
	for _, col := range schema.Columns {
		cell, ok := row[col.ID]
		if !ok || cell.IsMissing() || cell.IsUnchanged() {
			return nil, fmt.Errorf("%w: %s: column %q is missing", ErrInvalidRow, context, col.ID)
		}
		if err := validateConcreteCell(cell, col); err != nil {
			return nil, fmt.Errorf("%w: %s: column %q: %v", ErrInvalidRow, context, col.ID, err)
		}
		out[col.ID] = cell.Clone()
	}
	return out, nil
}

// validateConcreteCell checks kind, column type and nullability.
func validateConcreteCell(cell Cell, col Column) error {
	switch cell.Kind {
	case CellNull:
		if !col.Nullable {
			return fmt.Errorf("NULL is not allowed in non-nullable %s column", col.Type)
		}
	case CellInt64:
		if col.Type != TypeInt64 {
			return fmt.Errorf("got int64 value for %s column", col.Type)
		}
	case CellBytes:
		if col.Type != TypeBytes {
			return fmt.Errorf("got byte-string value for %s column", col.Type)
		}
	case CellMissing, CellUnchanged:
		return fmt.Errorf("got %s cell instead of a concrete value", cell.Kind)
	default:
		return fmt.Errorf("unknown cell kind %d", cell.Kind)
	}
	return nil
}

func allSources(schema Schema, source FieldSource) map[string]FieldSource {
	out := make(map[string]FieldSource, len(schema.Columns))
	for _, col := range schema.Columns {
		out[col.ID] = source
	}
	return out
}
