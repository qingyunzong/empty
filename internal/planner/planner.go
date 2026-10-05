// Package planner selects a minimum-cost set of assertions so that every
// fault model is distinguishable from the normal model, subject to
// side-effect mutex and prerequisite constraints.
package planner

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

const (
	MaxAssertions  = 18
	MaxFaultModels = 12
)

// Assertion is a candidate check that may be selected by the planner.
type Assertion struct {
	ID       string   `json:"id"`
	Cost     int      `json:"cost"`
	Mutex    []string `json:"mutex,omitempty"`    // side effects conflict with these assertions
	Requires []string `json:"requires,omitempty"` // prerequisites that must also be selected
}

// Model is the normal model or a fault model, described by the boolean
// outcome every assertion produces under it.
type Model struct {
	ID       string          `json:"id"`
	Outcomes map[string]bool `json:"outcomes"`
}

// Spec is the planner input: candidate assertions plus the normal model and
// the fault models.
type Spec struct {
	NormalID   string      `json:"normal"`
	Assertions []Assertion `json:"assertions"`
	Models     []Model     `json:"models"`
}

// Problem is a validated, bitmask-encoded Spec ready for solving.
type Problem struct {
	assertions []Assertion
	costs      []int
	requires   []uint64
	mutex      []uint64
	faults     []string
	dist       []uint64 // per fault model: assertions whose outcome differs from normal
	indist     []string // fault models no assertion can distinguish
}

// Compile validates the spec and encodes it as a Problem.
func Compile(spec Spec) (*Problem, error) {
	if len(spec.Assertions) == 0 {
		return nil, errors.New("no candidate assertions")
	}
	if len(spec.Assertions) > MaxAssertions {
		return nil, fmt.Errorf("too many assertions: %d > %d", len(spec.Assertions), MaxAssertions)
	}
	idx := make(map[string]int, len(spec.Assertions))
	for i, a := range spec.Assertions {
		if a.ID == "" {
			return nil, fmt.Errorf("assertion %d: empty id", i)
		}
		if _, dup := idx[a.ID]; dup {
			return nil, fmt.Errorf("duplicate assertion id %q", a.ID)
		}
		if a.Cost < 0 {
			return nil, fmt.Errorf("assertion %q: negative cost", a.ID)
		}
		idx[a.ID] = i
	}
	var normal *Model
	faults := 0
	for i := range spec.Models {
		m := &spec.Models[i]
		if m.ID == spec.NormalID {
			if normal != nil {
				return nil, fmt.Errorf("duplicate normal model %q", m.ID)
			}
			normal = m
			continue
		}
		faults++
	}
	if normal == nil {
		return nil, fmt.Errorf("normal model %q not found", spec.NormalID)
	}
	if faults == 0 {
		return nil, errors.New("no fault models")
	}
	if faults > MaxFaultModels {
		return nil, fmt.Errorf("too many fault models: %d > %d", faults, MaxFaultModels)
	}
	for i := range spec.Models {
		for _, a := range spec.Assertions {
			if _, ok := spec.Models[i].Outcomes[a.ID]; !ok {
				return nil, fmt.Errorf("model %q: missing outcome for assertion %q", spec.Models[i].ID, a.ID)
			}
		}
	}

	p := &Problem{assertions: spec.Assertions}
	p.costs = make([]int, len(spec.Assertions))
	p.requires = make([]uint64, len(spec.Assertions))
	p.mutex = make([]uint64, len(spec.Assertions))
	for i, a := range spec.Assertions {
		p.costs[i] = a.Cost
		for _, r := range a.Requires {
			j, ok := idx[r]
			if !ok {
				return nil, fmt.Errorf("assertion %q: unknown prerequisite %q", a.ID, r)
			}
			if j == i {
				return nil, fmt.Errorf("assertion %q: self prerequisite", a.ID)
			}
			p.requires[i] |= 1 << uint(j)
		}
		for _, m := range a.Mutex {
			j, ok := idx[m]
			if !ok {
				return nil, fmt.Errorf("assertion %q: unknown mutex peer %q", a.ID, m)
			}
			if j == i {
				return nil, fmt.Errorf("assertion %q: self mutex", a.ID)
			}
			p.mutex[i] |= 1 << uint(j)
		}
	}
	// Mutex is symmetric: a side-effect conflict blocks either order.
	for i := range p.mutex {
		for j := range p.mutex {
			if p.mutex[i]>>uint(j)&1 == 1 {
				p.mutex[j] |= 1 << uint(i)
			}
		}
	}
	// Prerequisites must be transitively closed so that selecting an
	// assertion drags in the whole prerequisite chain.
	for changed := true; changed; {
		changed = false
		for i := range p.requires {
			closed := p.requires[i]
			for m := p.requires[i]; m != 0; m &= m - 1 {
				closed |= p.requires[bitsTrailing(m)]
			}
			if closed != p.requires[i] {
				p.requires[i] = closed
				changed = true
			}
		}
	}
	for i := range p.requires {
		if p.requires[i]>>uint(i)&1 == 1 {
			return nil, fmt.Errorf("assertion %q: cyclic prerequisite chain", spec.Assertions[i].ID)
		}
	}

	for i := range spec.Models {
		m := &spec.Models[i]
		if m.ID == spec.NormalID {
			continue
		}
		var d uint64
		for j, a := range spec.Assertions {
			if m.Outcomes[a.ID] != normal.Outcomes[a.ID] {
				d |= 1 << uint(j)
			}
		}
		if d == 0 {
			p.indist = append(p.indist, m.ID)
			continue
		}
		p.faults = append(p.faults, m.ID)
		p.dist = append(p.dist, d)
	}
	return p, nil
}

func bitsTrailing(m uint64) int {
	i := 0
	for m&1 == 0 {
		m >>= 1
		i++
	}
	return i
}

// feasible reports whether the assertion subset mask satisfies mutex and
// prerequisite constraints and distinguishes every distinguishable fault
// model from normal.
func (p *Problem) feasible(mask uint64) bool {
	for i := range p.assertions {
		if mask>>uint(i)&1 == 0 {
			continue
		}
		if p.mutex[i]&mask != 0 || p.requires[i]&^mask != 0 {
			return false
		}
	}
	for _, d := range p.dist {
		if mask&d == 0 {
			return false
		}
	}
	return true
}

func (p *Problem) cost(mask uint64) int {
	c := 0
	for i, ci := range p.costs {
		if mask>>uint(i)&1 == 1 {
			c += ci
		}
	}
	return c
}

// Witness pairs a fault model with a selected assertion that distinguishes
// it from the normal model.
type Witness struct {
	Model     string
	Assertion string
}

// Certificate is the coverage certificate produced by Solve.
type Certificate struct {
	Selected          []string
	TotalCost         int
	Witnesses         []Witness
	Indistinguishable []string
	FeasibleSubsets   int
	Optimal           bool
	VerifyChecked     int
}

// Solve enumerates all 2^n assertion subsets (n <= 18) and returns a
// minimum-cost feasible plan together with its coverage certificate.
func (p *Problem) Solve() (*Certificate, error) {
	n := len(p.assertions)
	best := -1
	feasible := 0
	for mask := uint64(0); mask < uint64(1)<<uint(n); mask++ {
		if !p.feasible(mask) {
			continue
		}
		feasible++
		if best < 0 || p.cost(mask) < p.cost(uint64(best)) {
			best = int(mask)
		}
	}
	if best < 0 {
		return nil, errors.New("infeasible: no assertion subset distinguishes every fault model")
	}
	cert := p.certificate(uint64(best), feasible)
	ok, checked := p.Verify(cert.TotalCost)
	cert.Optimal = ok
	cert.VerifyChecked = checked
	return cert, nil
}

func (p *Problem) certificate(mask uint64, feasible int) *Certificate {
	cert := &Certificate{
		TotalCost:         p.cost(mask),
		Indistinguishable: append([]string(nil), p.indist...),
		FeasibleSubsets:   feasible,
	}
	for i, a := range p.assertions {
		if mask>>uint(i)&1 == 1 {
			cert.Selected = append(cert.Selected, a.ID)
		}
	}
	for k, d := range p.dist {
		w := d & mask
		first := bitsTrailing(w)
		cert.Witnesses = append(cert.Witnesses, Witness{
			Model:     p.faults[k],
			Assertion: p.assertions[first].ID,
		})
	}
	return cert
}

// Verify independently confirms optimality by enumerating assertion subsets
// in increasing cardinality and checking that no feasible subset is strictly
// cheaper than bound. It returns whether the bound is optimal and the number
// of subsets examined.
func (p *Problem) Verify(bound int) (bool, int) {
	n := len(p.assertions)
	checked := 0
	for k := 0; k <= n; k++ {
		cheaper := false
		combinations(n, k, func(combo []int) {
			if cheaper {
				return
			}
			var mask uint64
			cost := 0
			for _, i := range combo {
				mask |= 1 << uint(i)
				cost += p.costs[i]
			}
			if cost >= bound { // costs are non-negative: cannot beat bound
				return
			}
			checked++
			if p.feasible(mask) {
				cheaper = true
			}
		})
		if cheaper {
			return false, checked
		}
	}
	return true, checked
}

func combinations(n, k int, visit func([]int)) {
	combo := make([]int, 0, k)
	var rec func(start int)
	rec = func(start int) {
		if len(combo) == k {
			visit(append([]int(nil), combo...))
			return
		}
		for i := start; i <= n-(k-len(combo)); i++ {
			combo = append(combo, i)
			rec(i + 1)
			combo = combo[:len(combo)-1]
		}
	}
	rec(0)
}

// Format renders the certificate as a human-readable coverage certificate.
func (c *Certificate) Format() string {
	var b strings.Builder
	b.WriteString("COVERAGE CERTIFICATE\n")
	fmt.Fprintf(&b, "selected assertions (%d): %s\n", len(c.Selected), strings.Join(c.Selected, " "))
	fmt.Fprintf(&b, "total cost: %d\n", c.TotalCost)
	b.WriteString("coverage:\n")
	for _, w := range c.Witnesses {
		fmt.Fprintf(&b, "  %-8s distinguished from normal by %s\n", w.Model, w.Assertion)
	}
	if len(c.Indistinguishable) > 0 {
		ind := append([]string(nil), c.Indistinguishable...)
		sort.Strings(ind)
		fmt.Fprintf(&b, "indistinguishable models (listed separately): %s\n", strings.Join(ind, " "))
	} else {
		b.WriteString("indistinguishable models: none\n")
	}
	fmt.Fprintf(&b, "feasible subsets: %d\n", c.FeasibleSubsets)
	if c.Optimal {
		fmt.Fprintf(&b, "verification: enumerated %d cheaper-candidate subsets by cardinality; none feasible => OPTIMAL\n", c.VerifyChecked)
	} else {
		b.WriteString("verification: FAILED, a cheaper feasible subset exists\n")
	}
	return b.String()
}
