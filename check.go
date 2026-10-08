package matchcheck

import "fmt"

// Branch is one arm of a match. A guarded branch is analyzed for
// reachability but is never treated as guaranteeing coverage, because the
// guard may evaluate to false.
type Branch struct {
	Pattern  Pattern
	HasGuard bool
}

// Report summarizes the analysis of a match expression.
type Report struct {
	// Unreachable lists the indices of branches that can never match:
	// every value they could match is already covered by earlier
	// unguarded branches.
	Unreachable []int
	// Uncovered lists minimal witness patterns for the values no
	// unguarded branch covers. Empty means the unguarded branches cover
	// the whole scrutinee type.
	Uncovered []Pattern
	// Exhaustive is true only when nothing is uncovered, the scrutinee
	// type is fully known, and the analysis stayed within budget.
	Exhaustive bool
	// ContainsUnknown is true when the scrutinee type mentions Unknown;
	// such a match can never be called exhaustive.
	ContainsUnknown bool
	// OverBudget is true when the witness set or the value enumeration
	// exceeded the budget; coverage claims are then abandoned.
	OverBudget bool
	// EnumVerified is true when the scrutinee type was small enough to
	// enumerate every value and the uncovered witnesses were confirmed
	// value by value.
	EnumVerified bool
}

// Check analyzes branches matched against a value of type scrutinee.
// budget caps both the number of uncovered witness patterns tracked and
// the number of values enumerated for small-type verification.
func Check(scrutinee Type, branches []Branch, budget int) (Report, error) {
	if budget < 1 {
		budget = 1
	}
	rep := Report{ContainsUnknown: scrutinee.containsUnknown()}

	for i, b := range branches {
		if err := validate(scrutinee, b.Pattern); err != nil {
			return rep, fmt.Errorf("branch %d: %w", i, err)
		}
	}

	// uncovered holds the minimal witness patterns for values not yet
	// covered by any unguarded branch.
	uncovered := []Pattern{Wildcard{}}
	for i, b := range branches {
		if intersectsAny(scrutinee, uncovered, b.Pattern) {
			if !b.HasGuard {
				uncovered = subtractAll(scrutinee, uncovered, b.Pattern)
				if len(uncovered) > budget {
					rep.OverBudget = true
					rep.Uncovered = nil
					return rep, nil
				}
			}
		} else {
			rep.Unreachable = append(rep.Unreachable, i)
		}
	}
	rep.Uncovered = uncovered
	rep.Exhaustive = len(uncovered) == 0 && !rep.ContainsUnknown

	// Small types: enumerate every value and confirm the witnesses.
	if n, ok := scrutinee.size(budget); ok && n <= budget {
		rep.EnumVerified = true
		verified := verifyByEnumeration(scrutinee, branches, uncovered)
		if !verified {
			rep.OverBudget = true
			rep.Exhaustive = false
			rep.Uncovered = nil
			return rep, fmt.Errorf("internal inconsistency: enumeration disagrees with witness set")
		}
	}
	return rep, nil
}

// verifyByEnumeration checks that the uncovered witness set agrees with a
// brute-force scan of every value of t: a value is unmatched by all
// unguarded branches iff it matches some witness.
func verifyByEnumeration(t Type, branches []Branch, witnesses []Pattern) bool {
	for _, v := range enumerate(t) {
		matched := false
		for _, b := range branches {
			if !b.HasGuard && matches(b.Pattern, v) {
				matched = true
				break
			}
		}
		witnessed := false
		for _, w := range witnesses {
			if matches(w, v) {
				witnessed = true
				break
			}
		}
		if matched == witnessed {
			return false
		}
	}
	return true
}

// intersectsAny reports whether pattern q matches at least one value
// described by the witness set ps.
func intersectsAny(t Type, ps []Pattern, q Pattern) bool {
	for _, p := range ps {
		if intersects(t, p, q) {
			return true
		}
	}
	return false
}

// intersects reports whether patterns p and q both match some common value
// of type t. Both must be well-typed against t.
func intersects(t Type, p, q Pattern) bool {
	switch p := p.(type) {
	case Wildcard:
		return true
	case Variant:
		switch q := q.(type) {
		case Wildcard:
			return true
		case Variant:
			return p.Name == q.Name
		}
		return false
	case TuplePat:
		switch q := q.(type) {
		case Wildcard:
			return true
		case TuplePat:
			tp := t.(Tuple)
			for i := range p.Elems {
				if !intersects(tp.Elems[i], p.Elems[i], q.Elems[i]) {
					return false
				}
			}
			return true
		}
		return false
	}
	return false
}

// subtractAll removes every value matched by q from the witness set ps.
func subtractAll(t Type, ps []Pattern, q Pattern) []Pattern {
	out := ps
	out = subtract(t, out, q)
	return out
}

func subtract(t Type, ps []Pattern, q Pattern) []Pattern {
	var out []Pattern
	for _, p := range ps {
		out = append(out, subtractOne(t, p, q)...)
	}
	return out
}

// subtractOne returns the minimal witness set for p \ q: the values matched
// by p but not by q.
func subtractOne(t Type, p, q Pattern) []Pattern {
	switch q := q.(type) {
	case Wildcard:
		return nil
	case Variant:
		switch p := p.(type) {
		case Wildcard:
			e := t.(Enum)
			var out []Pattern
			for _, v := range e.Variants {
				if v != q.Name {
					out = append(out, Variant{Name: v})
				}
			}
			return out
		case Variant:
			if p.Name == q.Name {
				return nil
			}
			return []Pattern{p}
		}
	case TuplePat:
		tp := t.(Tuple)
		switch p := p.(type) {
		case Wildcard:
			// Split on each position independently: keep wildcards
			// elsewhere and subtract only in position i.
			var out []Pattern
			for i := range q.Elems {
				for _, r := range subtractOne(tp.Elems[i], Wildcard{}, q.Elems[i]) {
					elems := make([]Pattern, len(q.Elems))
					for j := range elems {
						elems[j] = Wildcard{}
					}
					elems[i] = r
					out = append(out, TuplePat{Elems: elems})
				}
			}
			return out
		case TuplePat:
			var out []Pattern
			for i := range q.Elems {
				for _, r := range subtractOne(tp.Elems[i], p.Elems[i], q.Elems[i]) {
					elems := make([]Pattern, len(p.Elems))
					copy(elems, p.Elems)
					elems[i] = r
					out = append(out, TuplePat{Elems: elems})
				}
			}
			return out
		}
	}
	return []Pattern{p}
}
