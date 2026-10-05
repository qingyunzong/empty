// Package matrix builds minimal test-configuration matrices that cover all
// legal value pairs across a set of finite dimensions, subject to forbidden
// combinations and preconditions, and emits verifiable certificates.
package matrix

import (
	"encoding/json"
	"fmt"
	"io"
)

// Assignment is a partial or full mapping from dimension name to value.
type Assignment map[string]string

// Dimension is a finite named set of values.
type Dimension struct {
	Name   string   `json:"name"`
	Values []string `json:"values"`
}

// Precondition states: any configuration matching If must also match Then.
type Precondition struct {
	If   Assignment `json:"if"`
	Then Assignment `json:"then"`
}

// Spec describes the test matrix problem.
type Spec struct {
	Dimensions []Dimension    `json:"dimensions"`
	Forbidden  []Assignment   `json:"forbidden,omitempty"`
	Requires   []Precondition `json:"requires,omitempty"`
}

// LoadSpec decodes and validates a spec from r.
func LoadSpec(r io.Reader) (*Spec, error) {
	var spec Spec
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&spec); err != nil {
		return nil, fmt.Errorf("decoding spec: %w", err)
	}
	if err := spec.validate(); err != nil {
		return nil, err
	}
	return &spec, nil
}

func (s *Spec) validate() error {
	if len(s.Dimensions) == 0 {
		return fmt.Errorf("spec must declare at least one dimension")
	}
	seen := map[string]bool{}
	for i, d := range s.Dimensions {
		if d.Name == "" {
			return fmt.Errorf("dimension %d: empty name", i)
		}
		if seen[d.Name] {
			return fmt.Errorf("duplicate dimension %q", d.Name)
		}
		seen[d.Name] = true
		if len(d.Values) == 0 {
			return fmt.Errorf("dimension %q: no values", d.Name)
		}
		vseen := map[string]bool{}
		for _, v := range d.Values {
			if v == "" {
				return fmt.Errorf("dimension %q: empty value", d.Name)
			}
			if vseen[v] {
				return fmt.Errorf("dimension %q: duplicate value %q", d.Name, v)
			}
			vseen[v] = true
		}
	}
	for i, f := range s.Forbidden {
		if len(f) == 0 {
			return fmt.Errorf("forbidden[%d]: empty assignment", i)
		}
		if err := s.checkAssignment(f); err != nil {
			return fmt.Errorf("forbidden[%d]: %w", i, err)
		}
	}
	for i, r := range s.Requires {
		if len(r.If) == 0 {
			return fmt.Errorf("requires[%d]: empty if", i)
		}
		if len(r.Then) == 0 {
			return fmt.Errorf("requires[%d]: empty then", i)
		}
		if err := s.checkAssignment(r.If); err != nil {
			return fmt.Errorf("requires[%d].if: %w", i, err)
		}
		if err := s.checkAssignment(r.Then); err != nil {
			return fmt.Errorf("requires[%d].then: %w", i, err)
		}
	}
	return nil
}

func (s *Spec) checkAssignment(a Assignment) error {
	for dim, val := range a {
		d := s.dimension(dim)
		if d == nil {
			return fmt.Errorf("unknown dimension %q", dim)
		}
		found := false
		for _, v := range d.Values {
			if v == val {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("unknown value %q for dimension %q", val, dim)
		}
	}
	return nil
}

func (s *Spec) dimension(name string) *Dimension {
	for i := range s.Dimensions {
		if s.Dimensions[i].Name == name {
			return &s.Dimensions[i]
		}
	}
	return nil
}

// model is the compiled internal form of a Spec.
type model struct {
	spec    *Spec
	dimIdx  map[string]int
	forb    []map[int]int
	reqIf   []map[int]int
	reqThen []map[int]int
	// pairBase[i][j] is the id of the first pair for dimension pair (i,j), i<j.
	pairBase    [][]int
	numPairs    int
	totalCombos int
}

func buildModel(spec *Spec) (*model, error) {
	m := &model{spec: spec, dimIdx: map[string]int{}}
	for i, d := range spec.Dimensions {
		m.dimIdx[d.Name] = i
	}
	compile := func(a Assignment) map[int]int {
		out := make(map[int]int, len(a))
		for dim, val := range a {
			di := m.dimIdx[dim]
			for vi, v := range spec.Dimensions[di].Values {
				if v == val {
					out[di] = vi
					break
				}
			}
		}
		return out
	}
	for _, f := range spec.Forbidden {
		m.forb = append(m.forb, compile(f))
	}
	for _, r := range spec.Requires {
		m.reqIf = append(m.reqIf, compile(r.If))
		m.reqThen = append(m.reqThen, compile(r.Then))
	}
	n := len(spec.Dimensions)
	m.pairBase = make([][]int, n)
	total := 0
	for i := 0; i < n; i++ {
		m.pairBase[i] = make([]int, n)
		for j := i + 1; j < n; j++ {
			m.pairBase[i][j] = total
			total += len(spec.Dimensions[i].Values) * len(spec.Dimensions[j].Values)
		}
	}
	m.numPairs = total
	combos := 1
	for _, d := range spec.Dimensions {
		combos *= len(d.Values)
	}
	m.totalCombos = combos
	return m, nil
}

// pairID returns the id of pair (dim i = vi, dim j = vj) with i < j.
func (m *model) pairID(i, vi, j, vj int) int {
	return m.pairBase[i][j] + vi*len(m.spec.Dimensions[j].Values) + vj
}

// decodePair converts a pair id back to dimension/value indices (i<j).
func (m *model) decodePair(id int) (i, vi, j, vj int) {
	n := len(m.spec.Dimensions)
	for a := 0; a < n; a++ {
		for b := a + 1; b < n; b++ {
			size := len(m.spec.Dimensions[a].Values) * len(m.spec.Dimensions[b].Values)
			if id < m.pairBase[a][b]+size {
				off := id - m.pairBase[a][b]
				w := len(m.spec.Dimensions[b].Values)
				return a, off / w, b, off % w
			}
		}
	}
	return -1, -1, -1, -1
}
