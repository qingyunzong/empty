package solver

import "fmt"

// Result is the solver output: either a feasible certificate (Solution)
// or a minimal conflict constraint set (Conflict).
type Result struct {
	Status   string            `json:"status"` // "feasible" or "infeasible"
	Solution map[string]string `json:"solution,omitempty"`
	Changes  int               `json:"changes"`
	Conflict []string          `json:"conflict,omitempty"`
}

// Solve finds an optimal consistent version selection.
//
// Objective (lexicographic):
//  1. minimize the number of packages whose selected version differs
//     from the lock file (installing an unlocked package, removing a
//     locked one, or picking a different version each count as 1);
//  2. then maximize versions lexicographically in input package order
//     (higher version preferred; installed preferred over uninstalled).
func Solve(inst *Instance) (*Result, error) {
	c, err := compile(inst)
	if err != nil {
		return nil, err
	}
	if sat, _ := c.solveWith(nil, -1); !sat {
		var descs []string
		for _, i := range c.minimalCore() {
			descs = append(descs, c.constraints[i].desc)
		}
		return &Result{Status: "infeasible", Conflict: descs}, nil
	}

	// Phase 1: minimize the number of changes vs the lock file.
	k := 0
	for ; k <= len(inst.Packages); k++ {
		if sat, _ := c.solveWith(nil, k); sat {
			break
		}
	}
	if k > len(inst.Packages) {
		return nil, fmt.Errorf("internal error: no bounded solution for feasible instance")
	}

	// Phase 2: lexicographically maximize versions in input package order.
	var assumptions []int
	for p := range c.sorted {
		for rank := range c.sorted[p] {
			if sat, _ := c.solveWith(append(append([]int{}, assumptions...), c.xvar[p][rank]), k); sat {
				assumptions = append(assumptions, c.xvar[p][rank])
				break
			}
		}
		// If no version is assumable, the package stays uninstalled.
	}
	sat, model := c.solveWith(assumptions, k)
	if !sat {
		return nil, fmt.Errorf("internal error: assumptions became infeasible")
	}

	sol := make(map[string]string)
	for p, pkg := range c.inst.Packages {
		for rank, v := range c.sorted[p] {
			if model[c.xvar[p][rank]] == 1 {
				sol[pkg.Name] = v.Version
			}
		}
	}
	if err := Verify(inst, sol); err != nil {
		return nil, fmt.Errorf("internal error: invalid certificate: %v", err)
	}
	return &Result{Status: "feasible", Solution: sol, Changes: k}, nil
}

// Verify checks a certificate (selected versions) against the instance:
// every root is satisfied, every installed version's dependencies are
// satisfied by installed packages, and no conflict pair is installed.
func Verify(inst *Instance, sol map[string]string) error {
	find := func(name, version string) (*VersionSpec, error) {
		for _, p := range inst.Packages {
			if p.Name != name {
				continue
			}
			for i := range p.Versions {
				if p.Versions[i].Version == version {
					return &p.Versions[i], nil
				}
			}
			return nil, fmt.Errorf("package %q has no version %q", name, version)
		}
		return nil, fmt.Errorf("unknown package %q", name)
	}
	matches := func(rng, version string) (bool, error) {
		r, err := ParseRange(rng)
		if err != nil {
			return false, err
		}
		v, err := ParseVersion(version)
		if err != nil {
			return false, err
		}
		return r.Matches(v), nil
	}
	for name := range sol {
		if _, err := find(name, sol[name]); err != nil {
			return err
		}
	}
	for _, root := range inst.Roots {
		v, ok := sol[root.Name]
		if !ok {
			return fmt.Errorf("root %q is not installed", root.Name)
		}
		ok, err := matches(root.Range, v)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("root %s %s not satisfied by %s", root.Name, root.Range, v)
		}
	}
	for name, version := range sol {
		spec, err := find(name, version)
		if err != nil {
			return err
		}
		for _, d := range spec.Depends {
			dv, ok := sol[d.Name]
			if !ok {
				return fmt.Errorf("%s@%s requires %s %s: not installed", name, version, d.Name, d.Range)
			}
			ok, err := matches(d.Range, dv)
			if err != nil {
				return err
			}
			if !ok {
				return fmt.Errorf("%s@%s requires %s %s: got %s", name, version, d.Name, d.Range, dv)
			}
		}
		for _, cf := range spec.Conflicts {
			cv, ok := sol[cf.Name]
			if !ok {
				continue
			}
			ok, err := matches(cf.Range, cv)
			if err != nil {
				return err
			}
			if ok {
				return fmt.Errorf("%s@%s conflicts with %s %s: %s installed", name, version, cf.Name, cf.Range, cv)
			}
		}
	}
	return nil
}
