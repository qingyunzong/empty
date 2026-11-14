package dataeng

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

// Column describes one column in a relation schema version.
type Column struct {
	Name     string `json:"name"`
	Type     string `json:"type,omitempty"`
	Nullable bool   `json:"nullable,omitempty"`
}

// Relation is one immutable version of a PostgreSQL relation schema.
//
// Version distinguishes schema versions of the same relation ID. A tuple must
// always be interpreted with the exact version that produced it; consumers must
// not substitute the latest version after a DDL change.
type Relation struct {
	ID         uint32   `json:"id"`
	Version    uint32   `json:"version"`
	Namespace  string   `json:"namespace,omitempty"`
	Name       string   `json:"name"`
	Columns    []Column `json:"columns"`
	PrimaryKey []string `json:"primary_key"`
}

// Validate checks that a relation schema version is internally consistent.
func (r Relation) Validate() error {
	if r.ID == 0 {
		return fmt.Errorf("%w: relation ID must be non-zero", ErrInvalidRelation)
	}
	if r.Version == 0 {
		return fmt.Errorf("%w: relation %d version must be non-zero", ErrInvalidRelation, r.ID)
	}
	if strings.TrimSpace(r.Name) == "" {
		return fmt.Errorf("%w: relation %d has no name", ErrInvalidRelation, r.ID)
	}
	if len(r.Columns) == 0 {
		return fmt.Errorf("%w: relation %d has no columns", ErrInvalidRelation, r.ID)
	}
	columns := make(map[string]Column, len(r.Columns))
	for _, column := range r.Columns {
		if strings.TrimSpace(column.Name) == "" {
			return fmt.Errorf("%w: relation %d has a column with no name", ErrInvalidRelation, r.ID)
		}
		if _, exists := columns[column.Name]; exists {
			return fmt.Errorf("%w: relation %d has duplicate column %q", ErrInvalidRelation, r.ID, column.Name)
		}
		columns[column.Name] = column
	}
	if len(r.PrimaryKey) == 0 {
		return fmt.Errorf("%w: relation %d has no primary key; deduplication requires one", ErrInvalidRelation, r.ID)
	}
	keyColumns := make(map[string]struct{}, len(r.PrimaryKey))
	for _, name := range r.PrimaryKey {
		column, exists := columns[name]
		if !exists {
			return fmt.Errorf("%w: relation %d primary key references unknown column %q", ErrInvalidRelation, r.ID, name)
		}
		if column.Nullable {
			return fmt.Errorf("%w: relation %d primary key column %q is nullable", ErrInvalidRelation, r.ID, name)
		}
		if _, duplicate := keyColumns[name]; duplicate {
			return fmt.Errorf("%w: relation %d has duplicate primary key column %q", ErrInvalidRelation, r.ID, name)
		}
		keyColumns[name] = struct{}{}
	}
	return nil
}

// Equal reports whether two relation versions are exactly identical.
func (r Relation) Equal(other Relation) bool {
	if r.ID != other.ID || r.Version != other.Version ||
		r.Namespace != other.Namespace || r.Name != other.Name ||
		len(r.Columns) != len(other.Columns) ||
		len(r.PrimaryKey) != len(other.PrimaryKey) {
		return false
	}
	for i := range r.Columns {
		if r.Columns[i] != other.Columns[i] {
			return false
		}
	}
	for i := range r.PrimaryKey {
		if r.PrimaryKey[i] != other.PrimaryKey[i] {
			return false
		}
	}
	return true
}

// ColumnIndex returns the position of name in the schema.
func (r Relation) ColumnIndex(name string) (int, bool) {
	for i, column := range r.Columns {
		if column.Name == name {
			return i, true
		}
	}
	return 0, false
}

// Clone returns a deep copy of the relation.
func (r Relation) Clone() Relation {
	clone := r
	clone.Columns = append([]Column(nil), r.Columns...)
	clone.PrimaryKey = append([]string(nil), r.PrimaryKey...)
	return clone
}

// Value is a PostgreSQL value in its text representation. Null distinguishes
// SQL NULL from the empty string.
type Value struct {
	Data string `json:"data"`
	Null bool   `json:"null,omitempty"`
}

// NullValue returns a SQL NULL value.
func NullValue() Value { return Value{Null: true} }

// TextValue returns a non-NULL text value.
func TextValue(data string) Value { return Value{Data: data} }

// Row is a tuple keyed by column name. A missing column and a column with a
// NULL value are distinct at the wire level.
type Row map[string]Value

// Clone returns a deep copy of the row.
func (r Row) Clone() Row {
	if r == nil {
		return nil
	}
	clone := make(Row, len(r))
	for name, value := range r {
		clone[name] = value
	}
	return clone
}

// RowKey is the canonical identity of a row within one relation version.
type RowKey struct {
	RelationID      uint32 `json:"relation_id"`
	RelationVersion uint32 `json:"relation_version"`
	Encoded         string `json:"encoded"`
}

// String returns a stable representation suitable for maps and logs.
func (k RowKey) String() string {
	return fmt.Sprintf("%d/%d/%s", k.RelationID, k.RelationVersion, k.Encoded)
}

// Key derives the primary key identity of row using this exact schema version.
func (r Relation) Key(row Row) (RowKey, error) {
	if err := r.Validate(); err != nil {
		return RowKey{}, err
	}
	var buffer []byte
	buffer = binary.BigEndian.AppendUint32(buffer, uint32(len(r.PrimaryKey)))
	for _, name := range r.PrimaryKey {
		value, exists := row[name]
		if !exists || value.Null {
			return RowKey{}, fmt.Errorf("%w: relation %d version %d primary key column %q is missing or NULL",
				ErrInvalidRow, r.ID, r.Version, name)
		}
		if len(value.Data) > int(^uint32(0)) {
			return RowKey{}, fmt.Errorf("%w: relation %d key value for %q is too large", ErrInvalidRow, r.ID, name)
		}
		buffer = binary.BigEndian.AppendUint32(buffer, uint32(len(value.Data)))
		buffer = append(buffer, value.Data...)
	}
	return RowKey{
		RelationID:      r.ID,
		RelationVersion: r.Version,
		Encoded:         base64.RawURLEncoding.EncodeToString(buffer),
	}, nil
}

// ValidateRow checks that row only contains columns from this schema version.
// When requireAll is true, every column must be present (a NULL value is
// allowed). In both modes every primary key column must be present and non-NULL.
func (r Relation) ValidateRow(row Row, requireAll bool) error {
	if len(row) == 0 {
		return fmt.Errorf("%w: relation %d version %d row is empty", ErrInvalidRow, r.ID, r.Version)
	}
	known := make(map[string]struct{}, len(r.Columns))
	for _, column := range r.Columns {
		known[column.Name] = struct{}{}
		if requireAll {
			if _, exists := row[column.Name]; !exists {
				return fmt.Errorf("%w: relation %d version %d row is missing column %q",
					ErrInvalidRow, r.ID, r.Version, column.Name)
			}
		}
	}
	for name := range row {
		if _, exists := known[name]; !exists {
			return fmt.Errorf("%w: relation %d version %d row contains unknown column %q",
				ErrInvalidRow, r.ID, r.Version, name)
		}
	}
	for _, name := range r.PrimaryKey {
		value, exists := row[name]
		if !exists || value.Null {
			return fmt.Errorf("%w: relation %d version %d row has missing or NULL primary key column %q",
				ErrInvalidRow, r.ID, r.Version, name)
		}
	}
	return nil
}

// RowHash returns a stable digest of row values in schema column order. It is
// used to detect conflicting duplicate snapshot rows.
func (r Relation) RowHash(row Row) (string, error) {
	hash := sha256.New()
	var word [4]byte
	for _, column := range r.Columns {
		value, exists := row[column.Name]
		switch {
		case !exists:
			hash.Write([]byte{0})
		case value.Null:
			hash.Write([]byte{1})
		default:
			hash.Write([]byte{2})
			binary.BigEndian.PutUint32(word[:], uint32(len(value.Data)))
			hash.Write(word[:])
			hash.Write([]byte(value.Data))
		}
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// sortedRelations returns a copy sorted by relation ID and version.
func sortedRelations(relations []Relation) []Relation {
	sorted := make([]Relation, len(relations))
	for i, relation := range relations {
		sorted[i] = relation.Clone()
	}
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].ID != sorted[j].ID {
			return sorted[i].ID < sorted[j].ID
		}
		return sorted[i].Version < sorted[j].Version
	})
	return sorted
}
