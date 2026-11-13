package dataeng

import (
	"errors"
	"fmt"
	"strings"
)

// RelationID identifies a relation in the change stream. It is opaque to the
// package and only has to be stable for the lifetime of a stream.
type RelationID uint32

// ColumnType is the logical type of a column. Both the standard SQL type names
// and PostgreSQL style names can be used; validation is performed only for the
// names listed below. Other names are treated as opaque.
type ColumnType string

const (
	TypeBool        ColumnType = "bool"
	TypeInt2        ColumnType = "int2"
	TypeInt4        ColumnType = "int4"
	TypeInt8        ColumnType = "int8"
	TypeFloat4      ColumnType = "float4"
	TypeFloat8      ColumnType = "float8"
	TypeNumeric     ColumnType = "numeric"
	TypeText        ColumnType = "text"
	TypeVarchar     ColumnType = "varchar"
	TypeBytea       ColumnType = "bytea"
	TypeDate        ColumnType = "date"
	TypeTime        ColumnType = "time"
	TypeTimestamp   ColumnType = "timestamp"
	TypeTimestampTZ ColumnType = "timestamptz"
	TypeUUID        ColumnType = "uuid"
	TypeJSON        ColumnType = "json"
	TypeJSONB       ColumnType = "jsonb"
)

// Column describes one column in a relation description.
type Column struct {
	Name     string
	Type     ColumnType
	Identity bool
}

// Relation is a description of a relation (table) that has arrived on the
// stream. Columns are ordered as they appear in tuples.
type Relation struct {
	ID        RelationID
	Namespace string
	Name      string
	Columns   []Column
}

// ErrInvalidRelation reports a malformed relation description.
var ErrInvalidRelation = errors.New("dataeng: invalid relation")

// ErrRelationNotFound reports that a tuple arrived before its relation
// description.
var ErrRelationNotFound = errors.New("dataeng: relation description not found")

func (r Relation) clone() Relation {
	clone := r
	clone.Columns = append([]Column(nil), r.Columns...)
	return clone
}

func (r Relation) validate() error {
	if r.ID == 0 {
		return errorf(ErrInvalidRelation, "relation ID must not be zero")
	}
	if strings.TrimSpace(r.Name) == "" {
		return errorf(ErrInvalidRelation, "relation name must not be empty")
	}
	if len(r.Columns) == 0 {
		return errorf(ErrInvalidRelation, "relation %d has no columns", r.ID)
	}

	seen := make(map[string]struct{}, len(r.Columns))
	for i, col := range r.Columns {
		if strings.TrimSpace(col.Name) == "" {
			return errorf(ErrInvalidRelation, "relation %d column %d has an empty name", r.ID, i)
		}
		if _, ok := seen[col.Name]; ok {
			return errorf(ErrInvalidRelation, "relation %d has duplicate column %q", r.ID, col.Name)
		}
		seen[col.Name] = struct{}{}
		if strings.TrimSpace(string(col.Type)) == "" {
			return errorf(ErrInvalidRelation, "relation %d column %q has an empty type", r.ID, col.Name)
		}
	}
	return nil
}

func (r Relation) identityIndexes() []int {
	indexes := make([]int, 0, len(r.Columns))
	for i, col := range r.Columns {
		if col.Identity {
			indexes = append(indexes, i)
		}
	}
	return indexes
}

func errorf(base error, format string, args ...any) error {
	return fmt.Errorf("%w: %s", base, fmt.Sprintf(format, args...))
}
