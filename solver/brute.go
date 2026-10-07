package solver

import "fmt"

// MaxBruteForceNodes caps the exhaustive enumerator's search space
// (product of version counts) so it stays a small-instance cross-check.
const MaxBruteForceNodes = 4_000_000

// BruteResult holds the outcome of an exhaustive enumeration.
type BruteResult struct {
	Best     Assignment
	Feasible bool
	Explored int // number of complete assignments evaluated
}

// BruteForce enumerates every version combination and returns the optimal
// assignment under the same objective as Solve. It is intended for
// cross-checking the branch-and-bound solver on small instances.
func BruteForce(in *Input) (BruteResult, error) {
	total := 1
	for _, p := range in.Packages {
		total *= len(p.Versions)
	}
	if total > MaxBruteForceNodes {
		return BruteResult{}, fmt.Errorf("instance too large for exhaustive enumeration: %d combinations > %d", total, MaxBruteForceNodes)
	}
	m := newModel(in, nil)
	res := BruteResult{}
	cur := map[string]string{}
	var rec func(i int)
	rec = func(i int) {
		if i == len(m.names) {
			res.Explored++
			if !m.consistent(cur) {
				return
			}
			if !res.Feasible || m.better(cur, res.Best) {
				res.Feasible = true
				res.Best = make(map[string]string, len(cur))
				for k, v := range cur {
					res.Best[k] = v
				}
			}
			return
		}
		name := m.names[i]
		for _, v := range m.versions[name] {
			cur[name] = v
			rec(i + 1)
		}
		delete(cur, name)
	}
	rec(0)
	return res, nil
}
