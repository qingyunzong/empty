package dataeng

// Cell is one value in a table row. Cells are always present in a Row, even
// when the agent did not return a value for that column. In that case Present
// is false while Column and ColumnIndex still identify the source column.
type Cell struct {
	ColumnIndex int
	Column      OID
	OID         OID
	Type        ValueType
	Value       any
	Present     bool
}

// Row is a table row aligned by its instance index.
type Row struct {
	Index OID
	Cells []Cell
}

// Cell returns the cell for column index.
func (r Row) Cell(column int) (Cell, bool) {
	if column < 0 || column >= len(r.Cells) {
		return Cell{}, false
	}
	return r.Cells[column], true
}

// Value returns the value for column index and whether it was present.
func (r Row) Value(column int) (any, bool) {
	cell, ok := r.Cell(column)
	if !ok || !cell.Present {
		return nil, false
	}
	return cell.Value, true
}

// Table is the result of walking one or more table columns. Rows are sorted
// by Index and each row has one Cell per requested column.
type Table struct {
	Columns []OID
	Rows    []Row
}

// Row returns the row with the given index.
func (t *Table) Row(index OID) (Row, bool) {
	if t == nil {
		return Row{}, false
	}
	for _, row := range t.Rows {
		if row.Index.Equal(index) {
			return row, true
		}
	}
	return Row{}, false
}

// ColumnValues returns the present values for a column, aligned with Rows.
// Missing cells are nil.
func (t *Table) ColumnValues(column int) []any {
	if t == nil || column < 0 || column >= len(t.Columns) {
		return nil
	}
	values := make([]any, len(t.Rows))
	for i := range t.Rows {
		if t.Rows[i].Cells[column].Present {
			values[i] = t.Rows[i].Cells[column].Value
		}
	}
	return values
}
