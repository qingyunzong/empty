package main

import "fmt"

// Result is the outcome of a subtyping query.
type Result struct {
	OK     bool
	Path   []string // member path to the incompatibility, when !OK
	Reason string   // why the types are incompatible at Path
}

// Check decides whether sub is a structural subtype of sup, using the
// coinductive greatest fixed point: a pair of types is compatible unless
// a finite witness of incompatibility is reachable. Recursive cycles are
// therefore accepted (they are in the greatest fixed point).
//
// The search is breadth-first over (sub, sup) node pairs, so the first
// failure found lies on a shortest member path.
//
// Variance rules:
//   - interface members (fields) are covariant;
//   - function parameters are contravariant;
//   - function results are covariant;
//   - any is the top type; primitives match by name.
func Check(sub, sup *Type) Result {
	type pair struct{ s, t *Type }
	type item struct {
		s, t *Type
		path []string
	}
	seen := map[pair]bool{}
	queue := []item{{sub, sup, nil}}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if seen[pair{cur.s, cur.t}] {
			continue // already assumed compatible: coinductive hypothesis
		}
		seen[pair{cur.s, cur.t}] = true
		s, t := cur.s, cur.t

		if t.Kind == KindAny {
			continue
		}
		if s.Kind == KindAny {
			return Result{false, cur.path,
				fmt.Sprintf("any is only a subtype of any, not of %s", describe(t))}
		}
		if s.Kind != t.Kind {
			return Result{false, cur.path,
				fmt.Sprintf("kind mismatch: %s vs %s", describe(s), describe(t))}
		}
		switch s.Kind {
		case KindPrim:
			if s.Name != t.Name {
				return Result{false, cur.path,
					fmt.Sprintf("primitive mismatch: %s vs %s", s.Name, t.Name)}
			}
		case KindFunc:
			if len(s.Params) != len(t.Params) {
				return Result{false, cur.path,
					fmt.Sprintf("parameter count mismatch: %d vs %d",
						len(s.Params), len(t.Params))}
			}
			for i := range s.Params {
				// Contravariant: the supertype's parameter must be a
				// subtype of the subtype's parameter.
				queue = append(queue, item{t.Params[i], s.Params[i],
					appendPath(cur.path, fmt.Sprintf("(arg %d)", i))})
			}
			queue = append(queue, item{s.Result, t.Result,
				appendPath(cur.path, "(result)")})
		case KindInterface:
			for _, m := range t.Members {
				sm := s.Lookup(m.Name)
				if sm == nil {
					return Result{false, appendPath(cur.path, "."+m.Name),
						fmt.Sprintf("missing member %q required by %s",
							m.Name, describe(t))}
				}
				queue = append(queue, item{sm, m.Type,
					appendPath(cur.path, "."+m.Name)})
			}
		}
	}
	return Result{OK: true}
}

func appendPath(path []string, elem string) []string {
	out := make([]string, len(path)+1)
	copy(out, path)
	out[len(path)] = elem
	return out
}
