package main

import (
	"fmt"
	"sort"
)

// maxNodes caps the branch-and-bound search effort.
const maxNodes = 200_000_000

// Solve finds an optimal assignment: minimum total waiting time, ties broken
// by makespan. It uses depth-first branch and bound over per-ship candidate
// start times, checking berth-length capacity incrementally.
func Solve(p *Problem) (Solution, error) {
	if err := p.Validate(); err != nil {
		return Solution{}, err
	}
	cands := make([][]int, len(p.Ships))
	for i, s := range p.Ships {
		c, err := p.Candidates(s)
		if err != nil {
			return Solution{}, err
		}
		cands[i] = c
	}
	// Most-constrained-first ordering.
	order := make([]int, len(p.Ships))
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(a, b int) bool {
		ia, ib := order[a], order[b]
		if len(cands[ia]) != len(cands[ib]) {
			return len(cands[ia]) < len(cands[ib])
		}
		return p.Ships[ia].Arrival < p.Ships[ib].Arrival
	})
	// Suffix lower bounds on additional waiting time.
	suffixMin := make([]int, len(order)+1)
	for k := len(order) - 1; k >= 0; k-- {
		i := order[k]
		suffixMin[k] = suffixMin[k+1] + cands[i][0] - p.Ships[i].Arrival
	}

	sv := &solver{
		p:      p,
		cands:  cands,
		order:  order,
		suffix: suffixMin,
		starts: make([]int, len(p.Ships)),
		placed: make([]bool, len(p.Ships)),
	}
	sv.best.TotalWait = int(^uint(0) >> 1)
	sv.best.Makespan = int(^uint(0) >> 1)
	if err := sv.dfs(0, 0); err != nil {
		return Solution{}, err
	}
	if !sv.found {
		return Solution{}, fmt.Errorf("no feasible schedule")
	}
	return sv.best, nil
}

type solver struct {
	p      *Problem
	cands  [][]int
	order  []int
	suffix []int

	starts []int
	placed []bool

	best  Solution
	found bool
	nodes int
}

func (sv *solver) dfs(k, curWait int) error {
	sv.nodes++
	if sv.nodes > maxNodes {
		return fmt.Errorf("search node limit %d exceeded", maxNodes)
	}
	if curWait+sv.suffix[k] > sv.best.TotalWait {
		return nil
	}
	if k == len(sv.order) {
		sol := sv.p.evaluate(sv.starts)
		if !sv.found || better(sol, sv.best) {
			sv.best, sv.found = sol, true
		}
		return nil
	}
	i := sv.order[k]
	ship := sv.p.Ships[i]
	for _, t := range sv.cands[i] {
		w := curWait + t - ship.Arrival
		if w+sv.suffix[k+1] > sv.best.TotalWait {
			break // candidates sorted: later ones only wait longer
		}
		if !sv.canPlace(i, t) {
			continue
		}
		sv.starts[i], sv.placed[i] = t, true
		if err := sv.dfs(k+1, w); err != nil {
			return err
		}
		sv.placed[i] = false
	}
	return nil
}

// canPlace checks whether ship i occupying [t, t+duration) keeps the berth
// length capacity respected against all already placed ships.
func (sv *solver) canPlace(i, t int) bool {
	ship := sv.p.Ships[i]
	end := t + ship.Duration
	// Event points inside [t, end): sweep the concurrent load.
	points := []int{t}
	for j := range sv.p.Ships {
		if !sv.placed[j] {
			continue
		}
		js, je := sv.starts[j], sv.starts[j]+sv.p.Ships[j].Duration
		if je <= t || js >= end {
			continue
		}
		if js > t {
			points = append(points, js)
		}
		if je > t && je < end {
			points = append(points, je)
		}
	}
	sort.Ints(points)
	for _, pt := range points {
		load := ship.Length
		for j := range sv.p.Ships {
			if !sv.placed[j] {
				continue
			}
			if sv.starts[j] <= pt && pt < sv.starts[j]+sv.p.Ships[j].Duration {
				load += sv.p.Ships[j].Length
			}
		}
		if load > sv.p.BerthLength {
			return false
		}
	}
	return true
}
