package dataeng

import (
	"sort"
	"strconv"
	"strings"
)

// Tuple is an ordered database tuple.
type Tuple []Value

// Tuples is a set of tuples, returned in deterministic order by the
// interpreter.
type Tuples []Tuple

// NewTuple constructs a tuple.
func NewTuple(values ...Value) Tuple {
	return append(Tuple(nil), values...)
}

// Clone returns a deep copy of t.
func (t Tuple) Clone() Tuple {
	return append(Tuple(nil), t...)
}

// Equal reports whether t and other contain exactly the same values.
func (t Tuple) Equal(other Tuple) bool {
	if len(t) != len(other) {
		return false
	}
	for i := range t {
		if t[i] != other[i] {
			return false
		}
	}
	return true
}

// Len returns the number of tuples.
func (ts Tuples) Len() int {
	return len(ts)
}

// Contains reports whether tuple is in the set.
func (ts Tuples) Contains(tuple Tuple) bool {
	key := tupleKey(tuple)
	for _, t := range ts {
		if tupleKey(t) == key {
			return true
		}
	}
	return false
}

// Clone returns a deep copy of the tuple set.
func (ts Tuples) Clone() Tuples {
	out := make(Tuples, len(ts))
	for i, t := range ts {
		out[i] = t.Clone()
	}
	return out
}

// Database is a finite database under set semantics. A relation absent from
// the map is empty. Duplicate tuples are ignored by the interpreter.
type Database struct {
	Relations map[string][]Tuple
}

// NewDatabase constructs an empty database.
func NewDatabase() *Database {
	return &Database{Relations: make(map[string][]Tuple)}
}

// Add appends a tuple to relation. Evaluation treats the relation as a set,
// so adding the same tuple repeatedly has no semantic effect.
func (d *Database) Add(relation string, values ...Value) {
	d.AddTuple(relation, Tuple(values))
}

// AddTuple appends a tuple to relation.
func (d *Database) AddTuple(relation string, tuple Tuple) {
	if d.Relations == nil {
		d.Relations = make(map[string][]Tuple)
	}
	d.Relations[relation] = append(d.Relations[relation], tuple.Clone())
}

// Clone returns a deep copy of the database.
func (d Database) Clone() Database {
	out := Database{Relations: make(map[string][]Tuple, len(d.Relations))}
	for relation, tuples := range d.Relations {
		out.Relations[relation] = make([]Tuple, len(tuples))
		for i, tuple := range tuples {
			out.Relations[relation][i] = tuple.Clone()
		}
	}
	return out
}

func appendValueKey(b *strings.Builder, v Value) {
	b.WriteString(strconv.Itoa(int(v.kind)))
	b.WriteByte(':')
	switch v.kind {
	case ValueConstant:
		b.WriteString(strconv.Itoa(len(v.text)))
		b.WriteByte(':')
		b.WriteString(v.text)
	case ValueFresh:
		b.WriteString(strconv.Itoa(v.freshID))
	}
	b.WriteByte(';')
}

func valueKey(v Value) string {
	var b strings.Builder
	appendValueKey(&b, v)
	return b.String()
}

func tupleKey(t Tuple) string {
	var b strings.Builder
	b.WriteString(strconv.Itoa(len(t)))
	b.WriteByte('|')
	for _, v := range t {
		appendValueKey(&b, v)
	}
	return b.String()
}

func appendTermKey(b *strings.Builder, t Term) {
	b.WriteString(strconv.Itoa(int(t.Kind)))
	b.WriteByte(':')
	b.WriteString(strconv.Itoa(len(t.Name)))
	b.WriteByte(':')
	b.WriteString(t.Name)
	b.WriteByte(';')
}

func termsKey(terms []Term) string {
	var b strings.Builder
	b.WriteString(strconv.Itoa(len(terms)))
	b.WriteByte('|')
	for _, t := range terms {
		appendTermKey(&b, t)
	}
	return b.String()
}

func atomKey(atom Atom) string {
	var b strings.Builder
	b.WriteString(strconv.Itoa(len(atom.Relation)))
	b.WriteByte(':')
	b.WriteString(atom.Relation)
	b.WriteByte('|')
	b.WriteString(termsKey(atom.Terms))
	return b.String()
}

func sortTuples(tuples []Tuple) {
	sort.Slice(tuples, func(i, j int) bool {
		return tupleKey(tuples[i]) < tupleKey(tuples[j])
	})
}
