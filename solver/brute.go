package solver

import "fmt"

// objective ranks full assignments: fewer lock changes first, then
// lexicographically higher version ranks in input package order
// (rank 0 = highest version; not installed counts as worst).
type objective struct {
	changes int
	ranks   []int
}

const notInstalledRank = 1 << 30

func better(a, b objective) bool {
	if a.changes != b.changes {
		return a.changes < b.changes
	}
	for i := range a.ranks {
		if a.ranks[i] != b.ranks[i] {
			return a.ranks[i] < b.ranks[i]
		}
	}
	return false
}

// assignmentFeasible checks an assignment directly against the input
// semantics, independently of the SAT encoding.
func assignmentFeasible(inst *Instance, assign []int, sorted [][]VersionSpec) bool {
	selected := func(p int) (string, bool) {
		if assign[p] < 0 {
			return "", false
		}
		return sorted[p][assign[p]].Version, true
	}
	verOf := func(name string) (string, bool) {
		for p := range inst.Packages {
			if inst.Packages[p].Name == name {
				return selected(p)
			}
		}
		return "", false
	}
	inRange := func(rng, version string) bool {
		r, err := ParseRange(rng)
		if err != nil {
			return false
		}
		v, err := ParseVersion(version)
		if err != nil {
			return false
		}
		return r.Matches(v)
	}
	for _, root := range inst.Roots {
		v, ok := verOf(root.Name)
		if !ok || !inRange(root.Range, v) {
			return false
		}
	}
	for p := range inst.Packages {
		if assign[p] < 0 {
			continue
		}
		spec := sorted[p][assign[p]]
		for _, d := range spec.Depends {
			dv, ok := verOf(d.Name)
			if !ok || !inRange(d.Range, dv) {
				return false
			}
		}
		for _, cf := range spec.Conflicts {
			if cv, ok := verOf(cf.Name); ok && inRange(cf.Range, cv) {
				return false
			}
		}
	}
	return true
}

func objectiveOf(inst *Instance, assign []int, sorted [][]VersionSpec) objective {
	obj := objective{ranks: make([]int, len(inst.Packages))}
	for p, pkg := range inst.Packages {
		obj.ranks[p] = assign[p]
		if assign[p] < 0 {
			obj.ranks[p] = notInstalledRank
		}
		lockV, locked := inst.Lock[pkg.Name]
		lockRank := -1
		if locked {
			lockRank = -2
			for r, v := range sorted[p] {
				if v.Version == lockV {
					lockRank = r
				}
			}
		}
		if assign[p] != lockRank {
			obj.changes++
		}
	}
	return obj
}

// bruteForce enumerates every assignment (each package: uninstalled or
// one of its versions) and returns the optimum under the same objective
// as Solve. Intended for cross-checking on small instances.
func bruteForce(inst *Instance) (bool, map[string]string, int, error) {
	c, err := compile(inst)
	if err != nil {
		return false, nil, 0, err
	}
	n := len(inst.Packages)
	assign := make([]int, n)
	var bestAssign []int
	var bestObj objective
	found := false
	var rec func(p int)
	rec = func(p int) {
		if p == n {
			if !assignmentFeasible(inst, assign, c.sorted) {
				return
			}
			obj := objectiveOf(inst, assign, c.sorted)
			if !found || better(obj, bestObj) {
				found = true
				bestObj = obj
				bestAssign = make([]int, n)
				copy(bestAssign, assign)
			}
			return
		}
		assign[p] = -1
		rec(p + 1)
		for r := range c.sorted[p] {
			assign[p] = r
			rec(p + 1)
		}
		assign[p] = -1
	}
	rec(0)
	if !found {
		return false, nil, 0, nil
	}
	sol := make(map[string]string)
	for p, pkg := range inst.Packages {
		if bestAssign[p] >= 0 {
			sol[pkg.Name] = c.sorted[p][bestAssign[p]].Version
		}
	}
	return true, sol, bestObj.changes, nil
}

// CrossCheck verifies Solve against full enumeration and, for
// infeasible instances, validates that the reported conflict core is
// unsatisfiable and inclusion-minimal.
func CrossCheck(inst *Instance) error {
	res, err := Solve(inst)
	if err != nil {
		return fmt.Errorf("solve: %v", err)
	}
	sat, sol, changes, err := bruteForce(inst)
	if err != nil {
		return fmt.Errorf("brute force: %v", err)
	}
	if sat != (res.Status == "feasible") {
		return fmt.Errorf("status mismatch: solve=%s brute-feasible=%v", res.Status, sat)
	}
	if !sat {
		c, err := compile(inst)
		if err != nil {
			return err
		}
		core := c.minimalCore()
		active := make([]bool, len(c.constraints))
		for _, i := range core {
			active[i] = true
		}
		if c.feasibleSet(active) {
			return fmt.Errorf("reported conflict core is satisfiable")
		}
		for _, i := range core {
			active[i] = false
			if !c.feasibleSet(active) {
				return fmt.Errorf("conflict core not minimal: constraint %q removable", c.constraints[i].desc)
			}
			active[i] = true
		}
		return nil
	}
	if res.Changes != changes {
		return fmt.Errorf("changes mismatch: solve=%d brute=%d", res.Changes, changes)
	}
	if len(res.Solution) != len(sol) {
		return fmt.Errorf("solution mismatch: solve=%v brute=%v", res.Solution, sol)
	}
	for name, v := range sol {
		if res.Solution[name] != v {
			return fmt.Errorf("solution mismatch for %q: solve=%s brute=%s", name, res.Solution[name], v)
		}
	}
	return nil
}
