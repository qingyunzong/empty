package matchcheck

// PatternKind classifies a Pattern.
type PatternKind int

const (
	// WildcardKind matches any value ("_").
	WildcardKind PatternKind = iota
	// LiteralKind matches one enum literal.
	LiteralKind
	// TuplePatternKind matches a tuple element-wise.
	TuplePatternKind
)

// Pattern is one case pattern.
type Pattern struct {
	Kind  PatternKind
	Value string     // enum literal (LiteralKind only)
	Elems []*Pattern // sub-patterns (TuplePatternKind only)
}

// Wild is the wildcard pattern "_".
func Wild() *Pattern { return &Pattern{Kind: WildcardKind} }

// Lit matches a single enum literal.
func Lit(value string) *Pattern { return &Pattern{Kind: LiteralKind, Value: value} }

// TuplePat matches a tuple element-wise.
func TuplePat(elems ...*Pattern) *Pattern {
	return &Pattern{Kind: TuplePatternKind, Elems: elems}
}

// matches reports whether p matches the concrete value v of type t.
func matches(t *Type, p *Pattern, v Value) bool {
	switch p.Kind {
	case WildcardKind:
		return true
	case LiteralKind:
		return t.Kind == EnumKind && v.Enum == p.Value
	case TuplePatternKind:
		if t.Kind != TupleKind || len(p.Elems) != len(t.Elems) {
			return false
		}
		for i, e := range p.Elems {
			if !matches(t.Elems[i], e, v.Tuple[i]) {
				return false
			}
		}
		return true
	}
	return false
}

// catchAll reports whether p matches every value of t.
func catchAll(t *Type, p *Pattern) bool {
	switch p.Kind {
	case WildcardKind:
		return true
	case TuplePatternKind:
		if t.Kind != TupleKind || len(p.Elems) != len(t.Elems) {
			return false
		}
		for i, e := range p.Elems {
			if !catchAll(t.Elems[i], e) {
				return false
			}
		}
		return true
	}
	return false
}
