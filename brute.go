package main

import "fmt"

// maxEnumerate caps the brute-force cross-check effort.
const maxEnumerate = 20_000_000

// BruteForce solves the instance by full enumeration of the cartesian
// product of every ship's candidate starts. It is exponential and intended
// as a ground-truth cross-check for small instances.
func BruteForce(p *Problem) (Solution, error) {
	if err := p.Validate(); err != nil {
		return Solution{}, err
	}
	cands := make([][]int, len(p.Ships))
	total := 1
	for i, s := range p.Ships {
		c, err := p.Candidates(s)
		if err != nil {
			return Solution{}, err
		}
		cands[i] = c
		total *= len(c)
		if total > maxEnumerate {
			return Solution{}, fmt.Errorf("enumeration space %d exceeds limit %d", total, maxEnumerate)
		}
	}
	best := Solution{TotalWait: int(^uint(0) >> 1), Makespan: int(^uint(0) >> 1)}
	found := false
	starts := make([]int, len(p.Ships))
	var rec func(k int)
	rec = func(k int) {
		if k == len(p.Ships) {
			if !p.feasible(starts) {
				return
			}
			sol := p.evaluate(starts)
			if !found || better(sol, best) {
				best, found = sol, true
			}
			return
		}
		for _, t := range cands[k] {
			starts[k] = t
			rec(k + 1)
		}
	}
	rec(0)
	if !found {
		return Solution{}, fmt.Errorf("no feasible schedule")
	}
	return best, nil
}
