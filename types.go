package dataeng

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Operation is the kind of row change carried by a CDC event.
type Operation string

const (
	// Insert adds an after image.
	Insert Operation = "insert"
	// Update replaces or merges fields from an after image.
	Update Operation = "update"
	// Delete removes the row identified by the before image.
	Delete Operation = "delete"
)

// Short aliases are provided because CDC adapters commonly spell operations
// this way.
const (
	OpInsert = Insert
	OpUpdate = Update
	OpDelete = Delete
)

// Value is a single decoded column value. The merge engine keeps the value's
// Go type in its canonical form for as long as the type can be encoded
// deterministically.
type Value = any

// Image is a decoded before or after row image. A missing column and a column
// whose value is nil are deliberately different: the former means "not
// supplied", while the latter is an actual NULL value.
type Image map[string]Value

// Clone returns a shallow copy of img. Column values are treated as immutable
// by the engine, so a shallow copy is sufficient for state isolation.
func (img Image) Clone() Image {
	if img == nil {
		return nil
	}
	out := make(Image, len(img))
	for column, value := range img {
		out[column] = value
	}
	return out
}

// Schema describes the primary key and, optionally, the complete column set
// for one table schema generation.
//
// A generation is intentionally part of a key's identity. Changes from
// different generations are never paired, because the meaning of the key may
// have changed with the schema.
type Schema struct {
	Table      string
	Generation uint64
	PrimaryKey []string
	Columns    []string
}

// Validate checks the fields that are required for a usable schema.
func (s Schema) Validate() error {
	if strings.TrimSpace(s.Table) == "" {
		return fmt.Errorf("%w: schema table is empty", ErrInvalidSchema)
	}
	if len(s.PrimaryKey) == 0 {
		return fmt.Errorf("%w: table %q generation %d has no primary key",
			ErrInvalidSchema, s.Table, s.Generation)
	}
	seen := make(map[string]struct{}, len(s.PrimaryKey))
	for _, column := range s.PrimaryKey {
		if strings.TrimSpace(column) == "" {
			return fmt.Errorf("%w: table %q generation %d has an empty primary-key column",
				ErrInvalidSchema, s.Table, s.Generation)
		}
		if _, exists := seen[column]; exists {
			return fmt.Errorf("%w: table %q generation %d repeats primary-key column %q",
				ErrInvalidSchema, s.Table, s.Generation, column)
		}
		seen[column] = struct{}{}
	}
	return nil
}

// Change is one ordered CDC row change. Before is required for deletes and
// updates; After is required for inserts and updates.
//
// PrimaryKey may be left empty when the schema has been registered with the
// Engine. When it is present it must agree with the registered schema.
type Change struct {
	Operation        Operation
	Table            string
	SchemaGeneration uint64
	PrimaryKey       []string
	Before           Image
	After            Image
}

// Event is an alias used by several CDC feed packages.
type Event = Change

// Transaction is the atomic unit observed from a CDC stream. All changes in a
// Transaction are applied together or not at all.
type Transaction struct {
	ID      string
	Changes []Change
}

// Key is a decoded primary key. Columns is ordered exactly like the schema's
// primary key, and Values is aligned with Columns.
type Key struct {
	Table            string
	SchemaGeneration uint64
	Columns          []string
	Values           []Value
}

// Equal reports whether two keys identify the same row in the same schema
// generation. Value comparison uses the same canonicalization as primary-key
// hashing, so equivalent numeric spellings compare equal.
func (k Key) Equal(other Key) bool {
	return k.canonical() == other.canonical()
}

// Map returns a fresh map representation of the key.
func (k Key) Map() map[string]Value {
	out := make(map[string]Value, len(k.Columns))
	for i, column := range k.Columns {
		if i < len(k.Values) {
			out[column] = k.Values[i]
		}
	}
	return out
}

// String returns a stable, human-readable representation of the key.
func (k Key) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s@%d(", k.Table, k.SchemaGeneration)
	for i, column := range k.Columns {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(column)
		b.WriteByte('=')
		if i < len(k.Values) {
			if encoded, err := canonicalValue(k.Values[i]); err == nil {
				b.Write(encoded)
			} else {
				b.WriteString(fmt.Sprintf("%v", k.Values[i]))
			}
		}
	}
	b.WriteByte(')')
	return b.String()
}

func (k Key) canonical() string {
	return fmt.Sprintf("generation=%d\x00%s", k.SchemaGeneration, k.rowIdentity())
}

// rowIdentity identifies a row by table and primary-key columns. Schema
// generation is deliberately absent: generations describe how a row is
// decoded, but they do not create a second namespace for the same table's
// unique index.
func (k Key) rowIdentity() string {
	parts := make([]string, 0, 3+2*len(k.Columns))
	parts = append(parts,
		"table="+escapePart(k.Table),
		fmt.Sprintf("columns=%d", len(k.Columns)),
	)
	for i, column := range k.Columns {
		parts = append(parts, "column="+escapePart(column))
		if i < len(k.Values) {
			encoded, err := canonicalValue(k.Values[i])
			if err != nil {
				encoded = []byte("!error:" + err.Error())
			}
			parts = append(parts, "value="+string(encoded))
		} else {
			parts = append(parts, "value=<missing>")
		}
	}
	return strings.Join(parts, "\x00")
}

func (k Key) clone() Key {
	out := k
	out.Columns = append([]string(nil), k.Columns...)
	out.Values = append([]Value(nil), k.Values...)
	return out
}

// Migration is a delete+insert pair proven to be a single primary-key move.
// From and To always belong to the same table and schema generation.
type Migration struct {
	ID               string
	TransactionID    string
	Table            string
	SchemaGeneration uint64
	From             Key
	To               Key
	DeleteChange     int
	InsertChange     int
}

// Result describes the durable effects of one transaction.
type Result struct {
	TransactionID string
	Migrations    []Migration
	ChangeCount   int
}

func (r Result) clone() Result {
	out := r
	out.Migrations = make([]Migration, len(r.Migrations))
	for i, migration := range r.Migrations {
		out.Migrations[i] = migration
		out.Migrations[i].From = migration.From.clone()
		out.Migrations[i].To = migration.To.clone()
	}
	return out
}

func sortedColumns(images ...Image) []string {
	seen := make(map[string]struct{})
	for _, image := range images {
		for column := range image {
			seen[column] = struct{}{}
		}
	}
	columns := make([]string, 0, len(seen))
	for column := range seen {
		columns = append(columns, column)
	}
	sort.Strings(columns)
	return columns
}

func stringSlicesEqual(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func escapePart(s string) string {
	// Length-prefixing is both simpler and safer than quoting. Keeping this
	// helper explicit makes the canonical key format readable.
	return fmt.Sprintf("%d:%s", len(s), s)
}

var errUnsupportedValue = errors.New("value type cannot be encoded deterministically")
