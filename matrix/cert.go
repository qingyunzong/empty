package matrix

import (
	"fmt"
	"math/big"
	"sort"
)

// Pair identifies one value pair across two dimensions (Dim1 before Dim2 in
// spec order).
type Pair struct {
	Dim1 string `json:"dim1"`
	Val1 string `json:"val1"`
	Dim2 string `json:"dim2"`
	Val2 string `json:"val2"`
}

// CoverageEntry maps one coverable pair to a covering configuration index.
type CoverageEntry struct {
	Pair   Pair `json:"pair"`
	Config int  `json:"config"`
}

// Certificate is a machine-checkable proof of legality and pair coverage.
type Certificate struct {
	Configs     []Assignment    `json:"configs"`
	Coverage    []CoverageEntry `json:"coverage"`
	Uncoverable []Pair          `json:"uncoverable"`
	Minimality  string          `json:"minimality"` // "exact" or "greedy"
}

// Solve computes a covering matrix of at most maxConfigs configurations and
// returns its certificate. The certificate is self-verified before return.
func Solve(spec *Spec, maxConfigs int) (*Certificate, error) {
	if maxConfigs < 1 {
		return nil, fmt.Errorf("maxConfigs must be >= 1")
	}
	out, err := solve(spec, maxConfigs)
	if err != nil {
		return nil, err
	}
	cert := out.certificate()
	if err := cert.Verify(spec); err != nil {
		return nil, fmt.Errorf("internal error: generated certificate failed verification: %w", err)
	}
	return cert, nil
}

// certificate assembles the certificate from a solveOutput.
func (o *solveOutput) certificate() *Certificate {
	cert := &Certificate{Minimality: "greedy"}
	if o.exact {
		cert.Minimality = "exact"
	}
	for _, idx := range o.chosen {
		cert.Configs = append(cert.Configs, o.model.toAssignment(o.legal[idx]))
	}
	// For every coverable pair, record the first chosen config covering it.
	for p := 0; p < o.model.numPairs; p++ {
		if o.coverable.Bit(p) == 0 {
			continue
		}
		for ci, idx := range o.chosen {
			if o.masks[idx].Bit(p) == 1 {
				cert.Coverage = append(cert.Coverage, CoverageEntry{Pair: o.model.pair(p), Config: ci})
				break
			}
		}
	}
	for p := 0; p < o.model.numPairs; p++ {
		if o.coverable.Bit(p) == 0 {
			cert.Uncoverable = append(cert.Uncoverable, o.model.pair(p))
		}
	}
	return cert
}

// pair renders a pair id as a Pair.
func (m *model) pair(id int) Pair {
	i, vi, j, vj := m.decodePair(id)
	return Pair{
		Dim1: m.spec.Dimensions[i].Name,
		Val1: m.spec.Dimensions[i].Values[vi],
		Dim2: m.spec.Dimensions[j].Name,
		Val2: m.spec.Dimensions[j].Values[vj],
	}
}

// Verify independently re-checks the certificate against the spec:
// every config is legal, every coverable pair is covered, and the
// uncoverable list matches a fresh enumeration.
func (c *Certificate) Verify(spec *Spec) error {
	if err := spec.validate(); err != nil {
		return err
	}
	m, err := buildModel(spec)
	if err != nil {
		return err
	}
	legal, err := m.enumerateLegal()
	if err != nil {
		return err
	}
	coverable := new(big.Int)
	for _, cfg := range legal {
		coverable.Or(coverable, m.pairMask(cfg))
	}
	// Legality: every selected config must satisfy all constraints.
	covered := new(big.Int)
	masks := make([]*big.Int, len(c.Configs))
	for ci, a := range c.Configs {
		assign, err := m.fullAssign(a)
		if err != nil {
			return fmt.Errorf("config %d: %w", ci, err)
		}
		if !m.legal(assign) {
			return fmt.Errorf("config %d violates constraints: %v", ci, a)
		}
		masks[ci] = m.pairMask(assign)
		covered.Or(covered, masks[ci])
	}
	// Coverage: every coverable pair must appear in some config.
	if new(big.Int).AndNot(coverable, covered).Sign() != 0 {
		return fmt.Errorf("certificate does not cover all coverable pairs")
	}
	// Coverage entries must be accurate.
	for _, e := range c.Coverage {
		if e.Config < 0 || e.Config >= len(c.Configs) {
			return fmt.Errorf("coverage entry references invalid config %d", e.Config)
		}
		id, err := m.pairIDFromNames(e.Pair)
		if err != nil {
			return err
		}
		if coverable.Bit(id) == 0 {
			return fmt.Errorf("coverage entry lists uncoverable pair %+v", e.Pair)
		}
		if masks[e.Config].Bit(id) == 0 {
			return fmt.Errorf("config %d does not contain pair %+v", e.Config, e.Pair)
		}
	}
	// Every coverable pair must have a coverage entry.
	if len(c.Coverage) != popcount(coverable) {
		return fmt.Errorf("coverage lists %d pairs, want %d", len(c.Coverage), popcount(coverable))
	}
	// Uncoverable list must match a fresh enumeration exactly.
	want := map[int]bool{}
	for p := 0; p < m.numPairs; p++ {
		if coverable.Bit(p) == 0 {
			want[p] = true
		}
	}
	if len(c.Uncoverable) != len(want) {
		return fmt.Errorf("uncoverable lists %d pairs, want %d", len(c.Uncoverable), len(want))
	}
	for _, p := range c.Uncoverable {
		id, err := m.pairIDFromNames(p)
		if err != nil {
			return err
		}
		if !want[id] {
			return fmt.Errorf("pair %+v is coverable but listed as uncoverable", p)
		}
	}
	return nil
}

// pairIDFromNames resolves a Pair to its internal id, checking spec order.
func (m *model) pairIDFromNames(p Pair) (int, error) {
	i, ok1 := m.dimIdx[p.Dim1]
	j, ok2 := m.dimIdx[p.Dim2]
	if !ok1 || !ok2 {
		return 0, fmt.Errorf("pair %+v references unknown dimension", p)
	}
	if i > j {
		i, j = j, i
		p.Val1, p.Val2 = p.Val2, p.Val1
	}
	if i == j {
		return 0, fmt.Errorf("pair %+v uses the same dimension twice", p)
	}
	vi, err := m.valueIndex(i, p.Val1)
	if err != nil {
		return 0, err
	}
	vj, err := m.valueIndex(j, p.Val2)
	if err != nil {
		return 0, err
	}
	return m.pairID(i, vi, j, vj), nil
}

func (m *model) valueIndex(dim int, val string) (int, error) {
	for vi, v := range m.spec.Dimensions[dim].Values {
		if v == val {
			return vi, nil
		}
	}
	return 0, fmt.Errorf("unknown value %q for dimension %q", val, m.spec.Dimensions[dim].Name)
}

// SortedPairs returns pairs in a stable, human-friendly order.
func SortedPairs(pairs []Pair) {
	sort.Slice(pairs, func(a, b int) bool {
		x, y := pairs[a], pairs[b]
		if x.Dim1 != y.Dim1 {
			return x.Dim1 < y.Dim1
		}
		if x.Dim2 != y.Dim2 {
			return x.Dim2 < y.Dim2
		}
		if x.Val1 != y.Val1 {
			return x.Val1 < y.Val1
		}
		return x.Val2 < y.Val2
	})
}
