package nameconstraints

import (
	"errors"
	"fmt"
)

// Set holds the name constraints accumulated from the CA certificates in a
// chain. Permitted constraints are grouped per CA so that constraints from
// the same CA take a union while constraints across CAs take an
// intersection; excluded constraints always accumulate by union.
type Set struct {
	// permitted[c][t] holds the union of permitted constraints of type t
	// declared by one CA. Absence of the type in a CA means that CA does
	// not constrain it.
	permitted []map[familyKey][]Constraint
	// excluded is the union of every CA's excluded constraints.
	excluded map[familyKey][]Constraint
}

// NewSet returns an empty, unrestricted constraint set.
func NewSet() *Set {
	return &Set{excluded: map[familyKey][]Constraint{}}
}

// AddCA merges one CA's permitted and excluded constraints.
//
// The CA's own permitted constraints are unioned internally; excluded
// constraints are added to the chain-wide exclusion union. A permitted type
// absent from this CA does not restrict that type.
func (s *Set) AddCA(permitted, excluded []Constraint) {
	group := map[familyKey][]Constraint{}
	for _, c := range permitted {
		key := c.constraintKey()
		group[key] = append(group[key], c)
	}
	if len(group) > 0 {
		s.permitted = append(s.permitted, group)
	}
	for _, c := range excluded {
		key := c.constraintKey()
		s.excluded[key] = append(s.excluded[key], c)
	}
}

// Permits reports whether a single SAN passes the accumulated constraints.
func (s *Set) Permits(name Name) bool {
	key := name.key()
	for _, c := range s.excluded[key] {
		if c.matches(name) {
			return false
		}
	}
	// A type no CA listed as permitted is unconstrained.
	for _, group := range s.permitted {
		constraints := group[key]
		if len(constraints) == 0 {
			continue
		}
		matched := false
		for _, c := range constraints {
			if c.matches(name) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	return true
}

// CheckNames requires every SAN to pass. All failures are collected into a
// single joined error so callers see the complete set of violations.
func (s *Set) CheckNames(names []Name) error {
	var failures []error
	for _, name := range names {
		key := name.key()
		excludedMatch, ok := firstMatch(s.excluded[key], name)
		if ok {
			failures = append(failures, &NameError{
				Name:   name,
				Reason: fmt.Sprintf("%s %q matches excluded constraint %q", typeName(name.Type), name.String(), excludedMatch.String()),
			})
			continue
		}

		permitted := true
		for _, group := range s.permitted {
			constraints := group[key]
			if len(constraints) == 0 {
				continue
			}
			if _, ok := firstMatch(constraints, name); !ok {
				permitted = false
				break
			}
		}
		if !permitted {
			failures = append(failures, &NameError{
				Name:   name,
				Reason: fmt.Sprintf("%s %q is not permitted by any constraint", typeName(name.Type), name.String()),
			})
		}
	}
	return errors.Join(failures...)
}

func firstMatch(constraints []Constraint, name Name) (Constraint, bool) {
	for _, c := range constraints {
		if c.matches(name) {
			return c, true
		}
	}
	return Constraint{}, false
}

func typeName(t NameType) string {
	switch t {
	case DNS:
		return "DNS name"
	case IP:
		return "IP address"
	default:
		return "name"
	}
}
