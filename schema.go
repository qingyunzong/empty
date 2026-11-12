package dataeng

import "fmt"

// ColumnType is the fixed value type of a column.
type ColumnType uint8

const (
	// TypeInt64 is a signed 64-bit integer column.
	TypeInt64 ColumnType = iota + 1
	// TypeBytes is a byte-string column.
	TypeBytes
)

const (
	// Int64Column is an alias for TypeInt64.
	Int64Column = TypeInt64
	// BytesColumn is an alias for TypeBytes.
	BytesColumn = TypeBytes
)

// String returns a readable name for the column type.
func (t ColumnType) String() string {
	switch t {
	case TypeInt64:
		return "int64"
	case TypeBytes:
		return "bytes"
	default:
		return fmt.Sprintf("columntype(%d)", t)
	}
}

// Column describes one fixed table column.
type Column struct {
	ID       string
	Type     ColumnType
	Nullable bool
}

// Schema is a fixed table schema with exactly one primary-key column.
//
// PrimaryKey names the column that forms the row identity. That column must be
// non-null and its values must be unique among rows.
type Schema struct {
	PrimaryKey string
	Columns    []Column
}

// NewSchema validates columns and returns a schema using primaryKey as the
// single primary-key column.
func NewSchema(primaryKey string, columns []Column) (Schema, error) {
	s := Schema{PrimaryKey: primaryKey, Columns: columns}.Clone()
	if err := s.Validate(); err != nil {
		return Schema{}, err
	}
	return s, nil
}

// Validate checks the schema invariants.
func (s Schema) Validate() error {
	if s.PrimaryKey == "" {
		return fmt.Errorf("%w: primary key column ID is empty", ErrInvalidSchema)
	}
	if len(s.Columns) == 0 {
		return fmt.Errorf("%w: no columns", ErrInvalidSchema)
	}

	seen := make(map[string]struct{}, len(s.Columns))
	var primary *Column
	for i, col := range s.Columns {
		if col.ID == "" {
			return fmt.Errorf("%w: column %d has an empty ID", ErrInvalidSchema, i)
		}
		if _, ok := seen[col.ID]; ok {
			return fmt.Errorf("%w: duplicate column ID %q", ErrInvalidSchema, col.ID)
		}
		seen[col.ID] = struct{}{}

		switch col.Type {
		case TypeInt64, TypeBytes:
		default:
			return fmt.Errorf("%w: column %q has invalid type %s", ErrInvalidSchema, col.ID, col.Type)
		}

		if col.ID == s.PrimaryKey {
			c := col
			primary = &c
		}
	}
	if primary == nil {
		return fmt.Errorf("%w: primary key column %q does not exist", ErrInvalidSchema, s.PrimaryKey)
	}
	if primary.Nullable {
		return fmt.Errorf("%w: primary key column %q must be non-null", ErrInvalidSchema, s.PrimaryKey)
	}
	return nil
}

// ColumnByID returns the column with the given ID.
func (s Schema) ColumnByID(id string) (Column, bool) {
	for _, col := range s.Columns {
		if col.ID == id {
			return col, true
		}
	}
	return Column{}, false
}

// PrimaryColumn returns the primary-key column.
func (s Schema) PrimaryColumn() (Column, bool) {
	return s.ColumnByID(s.PrimaryKey)
}

// Clone returns a schema whose column slice is independent of s.
func (s Schema) Clone() Schema {
	out := s
	out.Columns = append([]Column(nil), s.Columns...)
	return out
}

func (s Schema) columnMap() map[string]Column {
	m := make(map[string]Column, len(s.Columns))
	for _, col := range s.Columns {
		m[col.ID] = col
	}
	return m
}
