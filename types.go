package matchcheck

// Kind classifies a Type.
type Kind int

const (
	// UnknownKind is a type whose value space is not known to the
	// analyzer (e.g. integers, strings, or opaque foreign types).
	UnknownKind Kind = iota
	// EnumKind is a finite enumeration of named values.
	EnumKind
	// TupleKind is a product of element types.
	TupleKind
)

// Type describes the (possibly nested) shape of matched values.
type Type struct {
	Kind   Kind
	Name   string   // enum name (EnumKind only)
	Values []string // enum values in declaration order (EnumKind only)
	Elems  []*Type  // element types (TupleKind only)
}

// Enum declares a finite enum type with its values in declaration order.
func Enum(name string, values ...string) *Type {
	return &Type{Kind: EnumKind, Name: name, Values: values}
}

// Tuple declares a product type.
func Tuple(elems ...*Type) *Type {
	return &Type{Kind: TupleKind, Elems: elems}
}

// Unknown declares a type whose values cannot be enumerated.
func Unknown() *Type { return &Type{Kind: UnknownKind} }

// size returns the number of values of the type. ok is false when the
// type involves Unknown. Finite sizes above limit are capped at limit+1.
func (t *Type) size(limit int) (n int, ok bool) {
	switch t.Kind {
	case UnknownKind:
		return 0, false
	case EnumKind:
		return len(t.Values), true
	case TupleKind:
		total := 1
		for _, e := range t.Elems {
			s, ok := e.size(limit)
			if !ok {
				return 0, false
			}
			if s != 0 && total > limit/s {
				return limit + 1, true
			}
			total *= s
		}
		return total, true
	}
	return 0, false
}

// enumerate lists every value of the type. It reports ok=false when the
// type involves Unknown or has more than budget values.
func (t *Type) enumerate(budget int) (values []Value, ok bool) {
	n, ok := t.size(budget)
	if !ok || n > budget {
		return nil, false
	}
	switch t.Kind {
	case EnumKind:
		vals := make([]Value, 0, n)
		for _, v := range t.Values {
			vals = append(vals, Value{Enum: v})
		}
		return vals, true
	case TupleKind:
		vals := []Value{{Tuple: []Value{}}}
		for _, e := range t.Elems {
			ev, _ := e.enumerate(budget)
			next := make([]Value, 0, len(vals)*len(ev))
			for _, prefix := range vals {
				for _, v := range ev {
					tup := make([]Value, 0, len(prefix.Tuple)+1)
					tup = append(tup, prefix.Tuple...)
					tup = append(tup, v)
					next = append(next, Value{Tuple: tup})
				}
			}
			vals = next
		}
		return vals, true
	}
	return nil, false
}

// compare orders values of the type: enums by declaration order, tuples
// lexicographically by element.
func (t *Type) compare(a, b Value) int {
	switch t.Kind {
	case EnumKind:
		return indexOf(t.Values, a.Enum) - indexOf(t.Values, b.Enum)
	case TupleKind:
		for i, e := range t.Elems {
			if c := e.compare(a.Tuple[i], b.Tuple[i]); c != 0 {
				return c
			}
		}
	}
	return 0
}

func indexOf(values []string, v string) int {
	for i, s := range values {
		if s == v {
			return i
		}
	}
	return -1
}
