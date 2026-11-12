package dataeng

import (
	"bytes"
	"fmt"
	"strconv"
)

// CellKind identifies the value carried by a Cell.
//
// The zero kind is CellMissing, so the zero Cell represents an omitted field.
// CellMissing and CellUnchanged are not SQL NULL.
type CellKind uint8

const (
	// CellMissing means the field was omitted. In an update after-image it
	// means "unchanged"; in an insert it is invalid because inserts must
	// provide every column.
	CellMissing CellKind = iota
	// CellUnchanged explicitly marks a field as taking its value from the old
	// row. It is only valid in an update after-image.
	CellUnchanged
	// CellNull is a SQL NULL and is valid only for nullable columns.
	CellNull
	// CellInt64 carries an int64 value.
	CellInt64
	// CellBytes carries a byte-string value.
	CellBytes
)

// String returns a readable name for the cell kind.
func (k CellKind) String() string {
	switch k {
	case CellMissing:
		return "missing"
	case CellUnchanged:
		return "unchanged"
	case CellNull:
		return "null"
	case CellInt64:
		return "int64"
	case CellBytes:
		return "bytes"
	default:
		return "cellkind(" + strconv.FormatUint(uint64(k), 10) + ")"
	}
}

// Cell is a tagged row value.
//
// Only the field selected by Kind is meaningful: Int for CellInt64 and Bytes
// for CellBytes. A Cell must be created with one of the constructors (or with
// a struct literal using a valid kind); Table construction and batch
// application validate kinds and column types.
type Cell struct {
	Kind  CellKind
	Int   int64
	Bytes []byte
}

// MissingCell returns an omitted field.
func MissingCell() Cell {
	return Cell{Kind: CellMissing}
}

// UnchangedCell returns an explicit unchanged marker.
func UnchangedCell() Cell {
	return Cell{Kind: CellUnchanged}
}

// NullCell returns a SQL NULL.
func NullCell() Cell {
	return Cell{Kind: CellNull}
}

// Int64Cell returns an int64 value.
func Int64Cell(v int64) Cell {
	return Cell{Kind: CellInt64, Int: v}
}

// BytesCell returns a byte-string value. The input is copied so later
// mutations of b cannot change the cell.
func BytesCell(b []byte) Cell {
	return Cell{Kind: CellBytes, Bytes: cloneBytes(b)}
}

// IsMissing reports whether the field was omitted.
func (c Cell) IsMissing() bool {
	return c.Kind == CellMissing
}

// IsUnchanged reports whether the explicit unchanged marker is set.
func (c Cell) IsUnchanged() bool {
	return c.Kind == CellUnchanged
}

// IsNull reports whether the cell is SQL NULL.
func (c Cell) IsNull() bool {
	return c.Kind == CellNull
}

// IsConcrete reports whether the cell carries a concrete value (NULL, int64
// or bytes) rather than being missing or marked unchanged.
func (c Cell) IsConcrete() bool {
	switch c.Kind {
	case CellNull, CellInt64, CellBytes:
		return true
	default:
		return false
	}
}

// AsInt64 returns the int64 value and whether the cell carries one.
func (c Cell) AsInt64() (int64, bool) {
	if c.Kind != CellInt64 {
		return 0, false
	}
	return c.Int, true
}

// AsBytes returns a copy of the byte-string value and whether the cell carries
// one.
func (c Cell) AsBytes() ([]byte, bool) {
	if c.Kind != CellBytes {
		return nil, false
	}
	return cloneBytes(c.Bytes), true
}

// Clone returns a deep copy of the cell.
func (c Cell) Clone() Cell {
	out := c
	if c.Kind == CellBytes {
		out.Bytes = cloneBytes(c.Bytes)
	}
	return out
}

// Equal reports whether two cells have the same kind and value. Bytes are
// compared by content, not by slice identity.
func (c Cell) Equal(other Cell) bool {
	if c.Kind != other.Kind {
		return false
	}
	switch c.Kind {
	case CellMissing, CellUnchanged, CellNull:
		return true
	case CellInt64:
		return c.Int == other.Int
	case CellBytes:
		return bytes.Equal(c.Bytes, other.Bytes)
	default:
		return c.Int == other.Int && bytes.Equal(c.Bytes, other.Bytes)
	}
}

// String returns a readable representation of the cell.
func (c Cell) String() string {
	switch c.Kind {
	case CellMissing:
		return "missing"
	case CellUnchanged:
		return "unchanged"
	case CellNull:
		return "null"
	case CellInt64:
		return strconv.FormatInt(c.Int, 10)
	case CellBytes:
		return fmt.Sprintf("%q", c.Bytes)
	default:
		return fmt.Sprintf("cellkind(%d)", c.Kind)
	}
}

// canonicalKey returns a type-tagged map key for a primary-key cell.
func (c Cell) canonicalKey() string {
	switch c.Kind {
	case CellInt64:
		return "i:" + strconv.FormatInt(c.Int, 10)
	case CellBytes:
		return "b:" + string(c.Bytes)
	default:
		return ""
	}
}

// compareCells orders two primary-key cells. Both are expected to have the
// same concrete kind (the schema fixes the primary-key type).
func compareCells(a, b Cell) int {
	if a.Kind != b.Kind {
		if a.Kind < b.Kind {
			return -1
		}
		return 1
	}
	switch a.Kind {
	case CellInt64:
		switch {
		case a.Int < b.Int:
			return -1
		case a.Int > b.Int:
			return 1
		default:
			return 0
		}
	case CellBytes:
		return bytes.Compare(a.Bytes, b.Bytes)
	default:
		return 0
	}
}

func cloneBytes(b []byte) []byte {
	if b == nil {
		return nil
	}
	return append([]byte(nil), b...)
}
