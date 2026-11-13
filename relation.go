package dataeng

// Column describes one column of a relation generation.
type Column struct {
	Key     bool
	Name    string
	TypeOID uint32
	TypeMod int32
}

// Relation is one generation of a relation schema. Generation is a
// monotonically increasing sequence assigned by State as Relation messages
// arrive; a new Relation message for the same relation ID starts a new
// generation (e.g. after DDL).
type Relation struct {
	ID              uint32
	Namespace       string
	Name            string
	ReplicaIdentity byte
	Generation      uint64
	Columns         []Column
}

// ColumnByName returns the column with the given name.
func (r *Relation) ColumnByName(name string) (Column, bool) {
	for _, c := range r.Columns {
		if c.Name == name {
			return c, true
		}
	}
	return Column{}, false
}

// TupleValueKind classifies a single tuple field.
type TupleValueKind byte

const (
	TupleNull      TupleValueKind = 'n' // NULL
	TupleUnchanged TupleValueKind = 'u' // unchanged TOAST value
	TupleText      TupleValueKind = 't' // text format
	TupleBinary    TupleValueKind = 'b' // binary format
)

// TupleValue is one decoded field of a tuple.
type TupleValue struct {
	Kind TupleValueKind
	Data []byte
}

// Text returns the value as a string. Only meaningful for TupleText values.
func (v TupleValue) Text() string {
	return string(v.Data)
}

// Tuple is a decoded row bound to the Relation generation it was decoded
// against.
type Tuple struct {
	Relation *Relation
	Values   []TupleValue
}

// Get returns the value of the named column.
func (t Tuple) Get(name string) (TupleValue, bool) {
	if t.Relation == nil {
		return TupleValue{}, false
	}
	for i, c := range t.Relation.Columns {
		if c.Name == name && i < len(t.Values) {
			return t.Values[i], true
		}
	}
	return TupleValue{}, false
}
