package main

import "fmt"

// Dimension is a finite domain of named values.
type Dimension struct {
	Name   string   `json:"name"`
	Values []string `json:"values"`
}

// Assignment maps dimension names to values (may be partial).
type Assignment map[string]string

// Precondition is an implication: when `When` matches, `Require` must match.
type Precondition struct {
	When    Assignment `json:"when"`
	Require Assignment `json:"require"`
}

// Spec describes the full test-matrix problem.
type Spec struct {
	Dimensions    []Dimension    `json:"dimensions"`
	Forbidden     []Assignment   `json:"forbidden"`
	Preconditions []Precondition `json:"preconditions"`
}

// dimIndex maps dimension name to index.
func (s *Spec) dimIndex() map[string]int {
	m := make(map[string]int, len(s.Dimensions))
	for i, d := range s.Dimensions {
		m[d.Name] = i
	}
	return m
}

// valueIndex maps dimension index to (value -> value index).
func (s *Spec) valueIndex() map[int]map[string]int {
	m := make(map[int]map[string]int, len(s.Dimensions))
	for i, d := range s.Dimensions {
		vm := make(map[string]int, len(d.Values))
		for j, v := range d.Values {
			vm[v] = j
		}
		m[i] = vm
	}
	return m
}

// Validate checks structural well-formedness of the spec.
func (s *Spec) Validate() error {
	if len(s.Dimensions) == 0 {
		return fmt.Errorf("spec must declare at least one dimension")
	}
	seen := map[string]bool{}
	for _, d := range s.Dimensions {
		if d.Name == "" {
			return fmt.Errorf("dimension with empty name")
		}
		if seen[d.Name] {
			return fmt.Errorf("duplicate dimension %q", d.Name)
		}
		seen[d.Name] = true
		if len(d.Values) == 0 {
			return fmt.Errorf("dimension %q has no values", d.Name)
		}
		vseen := map[string]bool{}
		for _, v := range d.Values {
			if v == "" {
				return fmt.Errorf("dimension %q has an empty value", d.Name)
			}
			if vseen[v] {
				return fmt.Errorf("dimension %q has duplicate value %q", d.Name, v)
			}
			vseen[v] = true
		}
	}
	di := s.dimIndex()
	vi := s.valueIndex()
	checkPartial := func(a Assignment, ctx string) error {
		for name, val := range a {
			idx, ok := di[name]
			if !ok {
				return fmt.Errorf("%s references unknown dimension %q", ctx, name)
			}
			if _, ok := vi[idx][val]; !ok {
				return fmt.Errorf("%s references unknown value %q of dimension %q", ctx, val, name)
			}
		}
		return nil
	}
	for i, f := range s.Forbidden {
		if len(f) == 0 {
			return fmt.Errorf("forbidden[%d] is empty", i)
		}
		if err := checkPartial(f, fmt.Sprintf("forbidden[%d]", i)); err != nil {
			return err
		}
	}
	for i, p := range s.Preconditions {
		if len(p.When) == 0 {
			return fmt.Errorf("preconditions[%d].when is empty", i)
		}
		if len(p.Require) == 0 {
			return fmt.Errorf("preconditions[%d].require is empty", i)
		}
		if err := checkPartial(p.When, fmt.Sprintf("preconditions[%d].when", i)); err != nil {
			return err
		}
		if err := checkPartial(p.Require, fmt.Sprintf("preconditions[%d].require", i)); err != nil {
			return err
		}
	}
	return nil
}

// partialMatch reports whether cfg (value indices, -1 = unassigned) fully
// matches the partial assignment given as (dim idx -> value idx) pairs.
func partialMatch(cfg []int, partial [][2]int) bool {
	for _, pv := range partial {
		if cfg[pv[0]] != pv[1] {
			return false
		}
	}
	return true
}

// compiled constraints in index space for fast checks.
type compiledSpec struct {
	spec    *Spec
	forbid  [][][2]int
	preWhen [][][2]int
	preReq  [][][2]int
}

func compile(s *Spec) *compiledSpec {
	di := s.dimIndex()
	vi := s.valueIndex()
	toPairs := func(a Assignment) [][2]int {
		out := make([][2]int, 0, len(a))
		for name, val := range a {
			out = append(out, [2]int{di[name], vi[di[name]][val]})
		}
		return out
	}
	cs := &compiledSpec{spec: s}
	for _, f := range s.Forbidden {
		cs.forbid = append(cs.forbid, toPairs(f))
	}
	for _, p := range s.Preconditions {
		cs.preWhen = append(cs.preWhen, toPairs(p.When))
		cs.preReq = append(cs.preReq, toPairs(p.Require))
	}
	return cs
}

// consistentPartial reports whether a possibly partial config (unassigned = -1)
// can still be extended without already violating a constraint.
func (cs *compiledSpec) consistentPartial(cfg []int) bool {
	for _, f := range cs.forbid {
		if partialMatch(cfg, f) {
			return false
		}
	}
	for i, when := range cs.preWhen {
		if !partialMatch(cfg, when) {
			continue
		}
		// Some required dim already assigned to a wrong value -> dead end.
		for _, rv := range cs.preReq[i] {
			if cfg[rv[0]] != -1 && cfg[rv[0]] != rv[1] {
				return false
			}
		}
	}
	return true
}

// Legal reports whether a complete config satisfies all constraints.
func (cs *compiledSpec) Legal(cfg []int) bool {
	for _, v := range cfg {
		if v < 0 {
			return false
		}
	}
	for _, f := range cs.forbid {
		if partialMatch(cfg, f) {
			return false
		}
	}
	for i, when := range cs.preWhen {
		if partialMatch(cfg, when) && !partialMatch(cfg, cs.preReq[i]) {
			return false
		}
	}
	return true
}
