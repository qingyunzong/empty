package matchcheck

import "fmt"

// Pattern is a single case pattern: a wildcard, an enum variant, or a
// tuple of sub-patterns.
type Pattern interface {
	isPattern()
}

// Wildcard matches any value of the scrutinee type.
type Wildcard struct{}

// Variant matches one named variant of an Enum.
type Variant struct {
	Name string
}

// TuplePat matches a Tuple value element-wise.
type TuplePat struct {
	Elems []Pattern
}

func (Wildcard) isPattern() {}
func (Variant) isPattern()  {}
func (TuplePat) isPattern() {}

// validate checks that p is well-typed against t.
func validate(t Type, p Pattern) error {
	switch p := p.(type) {
	case Wildcard:
		return nil
	case Variant:
		e, ok := t.(Enum)
		if !ok {
			return fmt.Errorf("variant pattern %q against non-enum type", p.Name)
		}
		for _, v := range e.Variants {
			if v == p.Name {
				return nil
			}
		}
		return fmt.Errorf("variant %q is not a member of enum %q", p.Name, e.Name)
	case TuplePat:
		tp, ok := t.(Tuple)
		if !ok {
			return fmt.Errorf("tuple pattern of arity %d against non-tuple type", len(p.Elems))
		}
		if len(p.Elems) != len(tp.Elems) {
			return fmt.Errorf("tuple pattern arity %d does not match tuple type arity %d", len(p.Elems), len(tp.Elems))
		}
		for i := range p.Elems {
			if err := validate(tp.Elems[i], p.Elems[i]); err != nil {
				return err
			}
		}
		return nil
	default:
		return fmt.Errorf("unsupported pattern %T", p)
	}
}

// Value is a concrete value of a finite Type, produced by enumerate.
type Value interface {
	isValue()
}

// VariantValue is a concrete enum variant.
type VariantValue struct {
	Name string
}

// TupleValue is a concrete tuple of values.
type TupleValue struct {
	Elems []Value
}

func (VariantValue) isValue() {}
func (TupleValue) isValue()   {}

// matches reports whether pattern p matches value v.
func matches(p Pattern, v Value) bool {
	switch p := p.(type) {
	case Wildcard:
		return true
	case Variant:
		vv, ok := v.(VariantValue)
		return ok && vv.Name == p.Name
	case TuplePat:
		tv, ok := v.(TupleValue)
		if !ok || len(tv.Elems) != len(p.Elems) {
			return false
		}
		for i := range p.Elems {
			if !matches(p.Elems[i], tv.Elems[i]) {
				return false
			}
		}
		return true
	}
	return false
}

// enumerate lists every value of t. Callers must ensure t.size succeeded
// within their budget before calling.
func enumerate(t Type) []Value {
	switch t := t.(type) {
	case Enum:
		out := make([]Value, 0, len(t.Variants))
		for _, v := range t.Variants {
			out = append(out, VariantValue{Name: v})
		}
		return out
	case Tuple:
		sets := make([][]Value, len(t.Elems))
		total := 1
		for i, e := range t.Elems {
			sets[i] = enumerate(e)
			total *= len(sets[i])
		}
		out := make([]Value, 0, total)
		var rec func(i int, acc []Value)
		rec = func(i int, acc []Value) {
			if i == len(sets) {
				elems := make([]Value, len(acc))
				copy(elems, acc)
				out = append(out, TupleValue{Elems: elems})
				return
			}
			for _, v := range sets[i] {
				rec(i+1, append(acc, v))
			}
		}
		rec(0, nil)
		return out
	}
	return nil
}
