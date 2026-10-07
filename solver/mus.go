package solver

import "fmt"

// ConflictSet is a minimal (under deletion) set of constraints that is
// still unsatisfiable: removing any single member makes it satisfiable.
type ConflictSet struct {
	Constraints []string `json:"constraints"`
}

// MinimalConflict extracts a minimal unsatisfiable subset (MUS) of the
// input's roots, dependencies and conflicts using deletion-based
// minimization. It must only be called on infeasible inputs.
func MinimalConflict(in *Input) (ConflictSet, error) {
	all, err := buildConstraints(in)
	if err != nil {
		return ConflictSet{}, err
	}
	active := make([]bool, len(all))
	for i := range active {
		active[i] = true
	}
	if _, ok := solveActive(in, active); ok {
		return ConflictSet{}, fmt.Errorf("input is feasible; no conflict set exists")
	}
	for i := range all {
		active[i] = false
		if _, ok := solveActive(in, active); ok {
			active[i] = true // still needed for unsatisfiability
		}
	}
	set := ConflictSet{}
	for i, c := range all {
		if active[i] {
			set.Constraints = append(set.Constraints, c.Desc)
		}
	}
	return set, nil
}
