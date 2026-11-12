package dataeng

import (
	"fmt"
	"math"
)

// ColumnType identifies the physical type of a schema column. Every column is
// nullable; nullability is expressed per row through index -1.
type ColumnType int

const (
	// TypeInt64 declares a nullable int64 column.
	TypeInt64 ColumnType = iota + 1
	// TypeString declares a nullable string column.
	TypeString
)

// String returns the human-readable name of the column type.
func (t ColumnType) String() string {
	switch t {
	case TypeInt64:
		return "int64"
	case TypeString:
		return "string"
	default:
		return fmt.Sprintf("unknown(%d)", int(t))
	}
}

// Int64Column is a dictionary-encoded nullable int64 column. Each entry of
// Values is either -1 (null) or an index into Dict. Dict may hold duplicate
// values.
type Int64Column struct {
	Dict   []int64
	Values []int32
}

// StringColumn is a dictionary-encoded nullable string column. Each entry of
// Values is either -1 (null) or an index into Dict. Dict may hold duplicate
// values.
type StringColumn struct {
	Dict   []string
	Values []int32
}

// Batch is one input batch: a fixed row count and one dictionary-encoded
// column per schema column. Columns not declared in the schema are ignored.
type Batch struct {
	RowCount int
	Columns  map[string]any
}

// Schema declares the columns available to a predicate. Every column is
// either TypeInt64 or TypeString and is nullable.
type Schema struct {
	Columns map[string]ColumnType
}

// validateBatch fully validates the structural integrity of a batch against
// the schema. It always inspects every schema column, including columns that
// a compiled predicate never references, so short-circuiting during
// evaluation cannot hide malformed input.
func validateBatch(schema Schema, b *Batch) error {
	if b == nil {
		return fmt.Errorf("%w: nil batch", ErrInvalidBatch)
	}
	if b.RowCount < 0 {
		return fmt.Errorf("%w: negative row count %d", ErrInvalidBatch, b.RowCount)
	}
	for name, declared := range schema.Columns {
		raw, ok := b.Columns[name]
		if !ok {
			return fmt.Errorf("%w: missing column %q", ErrInvalidBatch, name)
		}
		switch col := raw.(type) {
		case nil:
			return fmt.Errorf("%w: column %q is nil", ErrInvalidBatch, name)
		case *Int64Column:
			if col == nil {
				return fmt.Errorf("%w: column %q is nil", ErrInvalidBatch, name)
			}
			if declared != TypeInt64 {
				return fmt.Errorf("%w: column %q holds int64 data but schema declares %s",
					ErrInvalidBatch, name, declared)
			}
			if err := validateIndices(name, len(col.Dict), col.Values, b.RowCount); err != nil {
				return err
			}
		case *StringColumn:
			if col == nil {
				return fmt.Errorf("%w: column %q is nil", ErrInvalidBatch, name)
			}
			if declared != TypeString {
				return fmt.Errorf("%w: column %q holds string data but schema declares %s",
					ErrInvalidBatch, name, declared)
			}
			if err := validateIndices(name, len(col.Dict), col.Values, b.RowCount); err != nil {
				return err
			}
		default:
			return fmt.Errorf("%w: column %q has unsupported type %T", ErrInvalidBatch, name, raw)
		}
	}
	return nil
}

// validateIndices checks that a column carries exactly one index per row and
// that every index is either -1 or within the dictionary bounds.
func validateIndices(name string, dictLen int, values []int32, rowCount int) error {
	if len(values) != rowCount {
		return fmt.Errorf("%w: column %q has %d indices for %d rows",
			ErrInvalidBatch, name, len(values), rowCount)
	}
	if dictLen > math.MaxInt32 {
		return fmt.Errorf("%w: column %q dictionary is too large", ErrInvalidBatch, name)
	}
	limit := int32(dictLen)
	for row, idx := range values {
		if idx < -1 || idx >= limit {
			return fmt.Errorf("%w: column %q row %d has out-of-range index %d",
				ErrInvalidBatch, name, row, idx)
		}
	}
	return nil
}
