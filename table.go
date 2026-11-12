package dataeng

// StringCell allocates a non-null cell holding value.
func StringCell(value string) Cell {
	return &value
}

// NullCell returns a cell representing null.
func NullCell() Cell {
	return nil
}

// Row builds a relation row from values; a nil entry becomes a null cell
// while non-nil entries keep their string value.
func Row(values ...*string) []Cell {
	row := make([]Cell, len(values))
	copy(row, values)
	return row
}
