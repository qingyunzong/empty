package solver

import (
	"fmt"
	"sort"
)

const (
	MaxPackages = 16
	MaxVersions = 4
)

// Dep is a dependency or conflict requirement on another package.
type Dep struct {
	Name  string `json:"name"`
	Range string `json:"range"`
}

// VersionSpec describes one version of a package.
type VersionSpec struct {
	Version   string `json:"version"`
	Depends   []Dep  `json:"depends,omitempty"`
	Conflicts []Dep  `json:"conflicts,omitempty"`
}

// Package groups the available versions of one package.
type Package struct {
	Name     string        `json:"name"`
	Versions []VersionSpec `json:"versions"`
}

// Instance is the solver input: a package universe, root requirements
// and an optional existing lock file (package name -> version).
type Instance struct {
	Packages []Package         `json:"packages"`
	Roots    []Dep             `json:"roots"`
	Lock     map[string]string `json:"lock,omitempty"`
}

type constraint struct {
	desc    string
	clauses [][]int
}

// compiled is the SAT encoding of an Instance.
//
// Variables: xvar[p][r] means "package p is installed at rank r"
// (rank 0 = highest version). change[p] means "package p's selected
// version differs from the lock file".
type compiled struct {
	inst          *Instance
	sorted        [][]VersionSpec // per package, versions sorted descending
	xvar          [][]int
	change        []int
	nvars         int
	structural    [][]int
	changeClauses [][]int
	constraints   []constraint
	allClauses    [][]int // structural + changeClauses + all constraints
}

func compile(inst *Instance) (*compiled, error) {
	if len(inst.Packages) == 0 {
		return nil, fmt.Errorf("instance has no packages")
	}
	if len(inst.Packages) > MaxPackages {
		return nil, fmt.Errorf("too many packages: %d > %d", len(inst.Packages), MaxPackages)
	}
	c := &compiled{inst: inst}
	idx := make(map[string]int, len(inst.Packages))
	for i, p := range inst.Packages {
		if p.Name == "" {
			return nil, fmt.Errorf("package #%d has empty name", i)
		}
		if _, dup := idx[p.Name]; dup {
			return nil, fmt.Errorf("duplicate package %q", p.Name)
		}
		if len(p.Versions) == 0 {
			return nil, fmt.Errorf("package %q has no versions", p.Name)
		}
		if len(p.Versions) > MaxVersions {
			return nil, fmt.Errorf("package %q has too many versions: %d > %d", p.Name, len(p.Versions), MaxVersions)
		}
		idx[p.Name] = i
		vs := make([]VersionSpec, len(p.Versions))
		copy(vs, p.Versions)
		seen := make(map[string]bool, len(vs))
		for _, v := range vs {
			if _, err := ParseVersion(v.Version); err != nil {
				return nil, fmt.Errorf("package %q: %v", p.Name, err)
			}
			if seen[v.Version] {
				return nil, fmt.Errorf("package %q: duplicate version %q", p.Name, v.Version)
			}
			seen[v.Version] = true
		}
		sort.Slice(vs, func(a, b int) bool {
			va, _ := ParseVersion(vs[a].Version)
			vb, _ := ParseVersion(vs[b].Version)
			return CompareVersion(va, vb) > 0
		})
		c.sorted = append(c.sorted, vs)
	}

	// Variable numbering.
	next := 1
	for _, vs := range c.sorted {
		row := make([]int, len(vs))
		for r := range vs {
			row[r] = next
			next++
		}
		c.xvar = append(c.xvar, row)
	}
	for range c.sorted {
		c.change = append(c.change, next)
		next++
	}
	c.nvars = next - 1

	// Structural clauses: at most one version per package.
	for _, row := range c.xvar {
		for i := 0; i < len(row); i++ {
			for j := i + 1; j < len(row); j++ {
				c.structural = append(c.structural, []int{-row[i], -row[j]})
			}
		}
	}

	// Change-tracking clauses.
	for p, pkg := range c.inst.Packages {
		cv := c.change[p]
		lockV, locked := inst.Lock[pkg.Name]
		lockRank := -1
		if locked {
			lockRank = -2 // locked version not among available versions
			for r, v := range c.sorted[p] {
				if v.Version == lockV {
					lockRank = r
				}
			}
		}
		switch {
		case !locked:
			for _, x := range c.xvar[p] {
				c.changeClauses = append(c.changeClauses, []int{-x, cv})
			}
		case lockRank >= 0:
			for r, x := range c.xvar[p] {
				if r != lockRank {
					c.changeClauses = append(c.changeClauses, []int{-x, cv})
				}
			}
			// Not installing the package at all is also a change.
			clause := make([]int, 0, len(c.xvar[p])+1)
			for _, x := range c.xvar[p] {
				clause = append(clause, x)
			}
			clause = append(clause, cv)
			c.changeClauses = append(c.changeClauses, clause)
		default: // locked to an unavailable version: any outcome is a change
			c.changeClauses = append(c.changeClauses, []int{cv})
		}
	}

	// User-level constraints (candidates for the conflict core).
	// matchVars returns the in-range and out-of-range variables of the
	// named package (nil, nil, nil if the package does not exist).
	matchVars := func(name, rng string) (in, out []int, err error) {
		r, err := ParseRange(rng)
		if err != nil {
			return nil, nil, err
		}
		q, ok := idx[name]
		if !ok {
			return nil, nil, nil
		}
		for rank, v := range c.sorted[q] {
			pv, _ := ParseVersion(v.Version)
			if r.Matches(pv) {
				in = append(in, c.xvar[q][rank])
			} else {
				out = append(out, c.xvar[q][rank])
			}
		}
		return in, out, nil
	}

	for _, root := range inst.Roots {
		in, out, err := matchVars(root.Name, root.Range)
		if err != nil {
			return nil, fmt.Errorf("root %q: %v", root.Name, err)
		}
		clauses := [][]int{in}
		for _, y := range out {
			clauses = append(clauses, []int{-y})
		}
		c.constraints = append(c.constraints, constraint{
			desc:    fmt.Sprintf("root: %s %s", root.Name, root.Range),
			clauses: clauses,
		})
	}
	for p, pkg := range c.inst.Packages {
		for rank, v := range c.sorted[p] {
			x := c.xvar[p][rank]
			for _, d := range v.Depends {
				in, out, err := matchVars(d.Name, d.Range)
				if err != nil {
					return nil, fmt.Errorf("package %q version %q: %v", pkg.Name, v.Version, err)
				}
				clauses := [][]int{append([]int{-x}, in...)}
				for _, y := range out {
					clauses = append(clauses, []int{-x, -y})
				}
				c.constraints = append(c.constraints, constraint{
					desc:    fmt.Sprintf("depends: %s@%s -> %s %s", pkg.Name, v.Version, d.Name, d.Range),
					clauses: clauses,
				})
			}
			for _, cf := range v.Conflicts {
				in, _, err := matchVars(cf.Name, cf.Range)
				if err != nil {
					return nil, fmt.Errorf("package %q version %q: %v", pkg.Name, v.Version, err)
				}
				var clauses [][]int
				for _, y := range in {
					clauses = append(clauses, []int{-x, -y})
				}
				if len(clauses) == 0 {
					continue // conflicts with nothing installable: vacuous
				}
				c.constraints = append(c.constraints, constraint{
					desc:    fmt.Sprintf("conflicts: %s@%s ! %s %s", pkg.Name, v.Version, cf.Name, cf.Range),
					clauses: clauses,
				})
			}
		}
	}

	c.allClauses = make([][]int, 0, len(c.structural)+len(c.changeClauses))
	c.allClauses = append(c.allClauses, c.structural...)
	c.allClauses = append(c.allClauses, c.changeClauses...)
	for _, con := range c.constraints {
		c.allClauses = append(c.allClauses, con.clauses...)
	}
	return c, nil
}

// solveWith solves with all constraints active, extra assumptions and a
// bound on the number of change variables (-1 = unbounded).
func (c *compiled) solveWith(assumptions []int, maxChanges int) (bool, []int8) {
	return solveClauses(c.allClauses, c.nvars, assumptions, c.change, maxChanges, c.xvar)
}

// feasibleSet checks satisfiability of structural clauses plus the
// constraints selected by active (used for conflict-core analysis).
func (c *compiled) feasibleSet(active []bool) bool {
	clauses := make([][]int, 0, len(c.structural))
	clauses = append(clauses, c.structural...)
	for i, con := range c.constraints {
		if active[i] {
			clauses = append(clauses, con.clauses...)
		}
	}
	sat, _ := solveClauses(clauses, c.nvars, nil, nil, -1, c.xvar)
	return sat
}

// minimalCore computes an inclusion-minimal unsatisfiable subset of the
// user-level constraints by deletion minimization. Returns indices into
// c.constraints. Caller must ensure the instance is unsatisfiable.
func (c *compiled) minimalCore() []int {
	active := make([]bool, len(c.constraints))
	for i := range active {
		active[i] = true
	}
	for i := range c.constraints {
		active[i] = false
		if c.feasibleSet(active) {
			active[i] = true
		}
	}
	var core []int
	for i, a := range active {
		if a {
			core = append(core, i)
		}
	}
	return core
}
