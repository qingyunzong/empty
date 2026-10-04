package main

import "sort"

// model is the compiled, solver-ready form of a Spec.
type model struct {
	spec      *Spec
	elemNames []string
	elemIndex map[string]int
	full      bitset

	cov  []bitset // direct coverage per test
	cost []int
	dur  []int

	// closure[i] is the bitmask of tests forced when test i is selected
	// (transitive requires, including i itself; cycles collapse naturally).
	closure     []uint32
	closureCov  []bitset
	closureCost []int
	closureDur  []int

	// Lower-bound data.
	minElemCost  []int    // min plain test cost covering each element
	maxCov       int      // max |cov[t]| over all tests
	suffixMaxCov []int    // max |cov[j]| for j >= i
	suffixUnion  []bitset // union of closureCov[j] for j >= i
}

func compile(s *Spec) *model {
	m := &model{spec: s, elemIndex: map[string]int{}}

	addElem := func(name string) int {
		if idx, ok := m.elemIndex[name]; ok {
			return idx
		}
		idx := len(m.elemNames)
		m.elemIndex[name] = idx
		m.elemNames = append(m.elemNames, name)
		return idx
	}

	// Universe: every public branch, then every pairwise interaction.
	for _, b := range s.Branches {
		addElem(branchElement(b))
	}
	feats := s.featureNames()
	for i := 0; i < len(feats); i++ {
		for j := i + 1; j < len(feats); j++ {
			for _, v1 := range s.Features[feats[i]] {
				for _, v2 := range s.Features[feats[j]] {
					addElem(pairElement(feats[i], v1, feats[j], v2))
				}
			}
		}
	}

	n := len(s.Tests)
	m.full = newBitset(len(m.elemNames))
	for i := range m.elemNames {
		m.full.set(i)
	}

	// Direct coverage per test.
	m.cov = make([]bitset, n)
	for i, t := range s.Tests {
		c := newBitset(len(m.elemNames))
		for _, b := range t.Branches {
			c.set(m.elemIndex[branchElement(b)])
		}
		// Every pair of assigned features contributes a covered interaction.
		var assigned []string
		for f := range t.Assign {
			assigned = append(assigned, f)
		}
		sort.Strings(assigned)
		for a := 0; a < len(assigned); a++ {
			for b := a + 1; b < len(assigned); b++ {
				f1, f2 := assigned[a], assigned[b]
				c.set(m.elemIndex[pairElement(f1, t.Assign[f1], f2, t.Assign[f2])])
			}
		}
		m.cov[i] = c
	}
	for _, t := range s.Tests {
		m.cost = append(m.cost, t.Cost)
		m.dur = append(m.dur, t.Duration)
	}

	// Prerequisite closures via transitive reachability (handles cycles).
	idxOf := map[string]int{}
	for i, t := range s.Tests {
		idxOf[t.Name] = i
	}
	m.closure = make([]uint32, n)
	for i := range s.Tests {
		var mask uint32
		stack := []int{i}
		for len(stack) > 0 {
			j := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if mask&(1<<uint(j)) != 0 {
				continue
			}
			mask |= 1 << uint(j)
			for _, r := range s.Tests[j].Requires {
				stack = append(stack, idxOf[r])
			}
		}
		m.closure[i] = mask
	}

	m.closureCov = make([]bitset, n)
	m.closureCost = make([]int, n)
	m.closureDur = make([]int, n)
	for i := range s.Tests {
		cc := newBitset(len(m.elemNames))
		for j := 0; j < n; j++ {
			if m.closure[i]&(1<<uint(j)) != 0 {
				cc.or(m.cov[j])
				m.closureCost[i] += m.cost[j]
				m.closureDur[i] += m.dur[j]
			}
		}
		m.closureCov[i] = cc
	}

	// Lower-bound data.
	m.minElemCost = make([]int, len(m.elemNames))
	for e := range m.minElemCost {
		best := -1
		for t := 0; t < n; t++ {
			if m.cov[t].test(e) && (best < 0 || m.cost[t] < best) {
				best = m.cost[t]
			}
		}
		m.minElemCost[e] = best // -1 means uncoverable
	}
	for t := 0; t < n; t++ {
		if c := m.cov[t].count(); c > m.maxCov {
			m.maxCov = c
		}
	}
	m.suffixMaxCov = make([]int, n+1)
	m.suffixUnion = make([]bitset, n+1)
	m.suffixUnion[n] = newBitset(len(m.elemNames))
	for i := n - 1; i >= 0; i-- {
		m.suffixMaxCov[i] = m.suffixMaxCov[i+1]
		if c := m.cov[i].count(); c > m.suffixMaxCov[i] {
			m.suffixMaxCov[i] = c
		}
		u := m.suffixUnion[i+1].clone()
		u.or(m.closureCov[i])
		m.suffixUnion[i] = u
	}
	return m
}

// uncoverable returns the names of elements no test can cover.
func (m *model) uncoverable() []string {
	var out []string
	for e, name := range m.elemNames {
		if m.minElemCost[e] < 0 {
			out = append(out, name)
		}
	}
	return out
}
