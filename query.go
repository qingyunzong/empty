package dataeng

// Atom is a relation atom. Terms must have exactly the relation arity.
type Atom struct {
	Relation string
	Terms    []Term
}

// Query is a conjunctive query with an ordered head and a conjunction of
// relation atoms. The zero-length head is valid.
type Query struct {
	Head []Term
	Body []Atom
}

// NewAtom constructs an atom and copies its terms.
func NewAtom(relation string, terms ...Term) Atom {
	return Atom{Relation: relation, Terms: append([]Term(nil), terms...)}
}

// NewQuery constructs a query and copies its head and body.
func NewQuery(head []Term, body ...Atom) Query {
	q := Query{
		Head: append([]Term(nil), head...),
		Body: make([]Atom, len(body)),
	}
	for i, atom := range body {
		q.Body[i] = Atom{
			Relation: atom.Relation,
			Terms:    append([]Term(nil), atom.Terms...),
		}
	}
	return q
}

// Schema maps relation names to positive arities.
type Schema struct {
	Arities map[string]int
}

// NewSchema constructs a schema and copies the arity map.
func NewSchema(arities map[string]int) Schema {
	m := make(map[string]int, len(arities))
	for relation, arity := range arities {
		m[relation] = arity
	}
	return Schema{Arities: m}
}

// Arity returns the declared arity of relation.
func (s Schema) Arity(relation string) (int, bool) {
	arity, ok := s.Arities[relation]
	return arity, ok
}
