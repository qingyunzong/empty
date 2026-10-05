package matrix

import (
	"fmt"
	"math/big"
)

// maxEnumerate caps the full configuration space we are willing to enumerate.
const maxEnumerate = 1 << 20

// matches reports whether the full assignment satisfies the partial one.
func matches(partial map[int]int, assign []int) bool {
	for dim, val := range partial {
		if assign[dim] != val {
			return false
		}
	}
	return true
}

// legal reports whether a full assignment satisfies all constraints.
func (m *model) legal(assign []int) bool {
	for _, f := range m.forb {
		if matches(f, assign) {
			return false
		}
	}
	for k := range m.reqIf {
		if matches(m.reqIf[k], assign) && !matches(m.reqThen[k], assign) {
			return false
		}
	}
	return true
}

// pairMask returns the set of pairs covered by a full assignment.
func (m *model) pairMask(assign []int) *big.Int {
	mask := new(big.Int)
	n := len(assign)
	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			mask.SetBit(mask, m.pairID(i, assign[i], j, assign[j]), 1)
		}
	}
	return mask
}

// enumerateLegal returns every legal configuration as a value-index vector.
func (m *model) enumerateLegal() ([][]int, error) {
	if m.totalCombos > maxEnumerate {
		return nil, fmt.Errorf("configuration space too large to enumerate: %d > %d", m.totalCombos, maxEnumerate)
	}
	n := len(m.spec.Dimensions)
	var out [][]int
	assign := make([]int, n)
	var walk func(dim int)
	walk = func(dim int) {
		if dim == n {
			if m.legal(assign) {
				cp := make([]int, n)
				copy(cp, assign)
				out = append(out, cp)
			}
			return
		}
		for v := range m.spec.Dimensions[dim].Values {
			assign[dim] = v
			walk(dim + 1)
		}
	}
	walk(0)
	return out, nil
}

// fullAssign converts a certificate assignment back to a value-index vector.
func (m *model) fullAssign(a Assignment) ([]int, error) {
	n := len(m.spec.Dimensions)
	out := make([]int, n)
	if len(a) != n {
		return nil, fmt.Errorf("config has unknown dimension keys")
	}
	for i, d := range m.spec.Dimensions {
		val, ok := a[d.Name]
		if !ok {
			return nil, fmt.Errorf("config missing dimension %q", d.Name)
		}
		found := false
		for vi, v := range d.Values {
			if v == val {
				out[i] = vi
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("config has unknown value %q for dimension %q", val, d.Name)
		}
	}
	return out, nil
}

// toAssignment renders a value-index vector as an Assignment.
func (m *model) toAssignment(assign []int) Assignment {
	out := make(Assignment, len(assign))
	for i, d := range m.spec.Dimensions {
		out[d.Name] = d.Values[assign[i]]
	}
	return out
}

func popcount(x *big.Int) int {
	count := 0
	for _, w := range x.Bits() {
		for w != 0 {
			w &= w - 1
			count++
		}
	}
	return count
}
