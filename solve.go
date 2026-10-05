package sched

import (
	"fmt"
	"math"
	"math/rand"
	"sort"
	"strings"
)

// Placement is one job's slot on the machine timeline. The machine performs
// the category changeover during [SetupStart, SetupStart+Setup), may then
// idle waiting for the job's release, and processes the job during
// [Start, End).
type Placement struct {
	Job        int
	Setup      int64
	SetupStart int64
	Start      int64
	End        int64
}

// Solution is a complete schedule plus its objective values.
type Solution struct {
	Order           []int // job indices in execution order
	Timeline        []Placement
	MaxLateness     int64 // max(C_j - Due_j), may be negative
	TotalCompletion int64 // sum of completion times
}

// better reports whether a is lexicographically better than b:
// lower MaxLateness first, then lower TotalCompletion.
func better(a, b Solution) bool {
	if a.MaxLateness != b.MaxLateness {
		return a.MaxLateness < b.MaxLateness
	}
	return a.TotalCompletion < b.TotalCompletion
}

func (in *Instance) setup(prev, cur int) int64 {
	if prev < 0 || in.Setup == nil {
		return 0
	}
	return in.Setup[in.Jobs[prev].Category][in.Jobs[cur].Category]
}

// evaluate builds the timeline for a precedence-feasible order and computes
// the objective values. Setups may run as soon as the machine is free; the
// job itself waits for its release time.
func (in *Instance) evaluate(order []int) Solution {
	sol := Solution{
		Order:       append([]int(nil), order...),
		Timeline:    make([]Placement, len(order)),
		MaxLateness: math.MinInt64,
	}
	machine := int64(0)
	prev := -1
	for pos, j := range order {
		s := in.setup(prev, j)
		start := machine + s
		if r := in.Jobs[j].Release; r > start {
			start = r
		}
		end := start + in.Jobs[j].Proc
		sol.Timeline[pos] = Placement{Job: j, Setup: s, SetupStart: machine, Start: start, End: end}
		if late := end - in.Jobs[j].Due; late > sol.MaxLateness {
			sol.MaxLateness = late
		}
		sol.TotalCompletion += end
		machine = end
		prev = j
	}
	return sol
}

// Solve validates the instance and returns an optimal (n <= ExhaustiveLimit)
// or best-effort heuristic schedule.
func (in *Instance) Solve() (Solution, error) {
	if err := in.Validate(); err != nil {
		return Solution{}, err
	}
	if len(in.Jobs) <= ExhaustiveLimit {
		return in.solveExhaustive(), nil
	}
	return in.solveHeuristic(), nil
}

// solveExhaustive enumerates every precedence-feasible order via DFS over
// the set of ready jobs, pruning partial schedules that can no longer beat
// the incumbent. Both objective components are non-decreasing as jobs are
// appended, so the bound is exact.
func (in *Instance) solveExhaustive() Solution {
	n := len(in.Jobs)
	indeg := make([]int, n)
	adj := make([][]int, n)
	for _, e := range in.Prec {
		indeg[e[1]]++
		adj[e[0]] = append(adj[e[0]], e[1])
	}
	best := Solution{MaxLateness: math.MaxInt64, TotalCompletion: math.MaxInt64}
	order := make([]int, 0, n)
	var rec func(machine int64, prev int, lmax, sumC int64)
	rec = func(machine int64, prev int, lmax, sumC int64) {
		if len(order) == n {
			cand := Solution{
				Order:           append([]int(nil), order...),
				MaxLateness:     lmax,
				TotalCompletion: sumC,
			}
			if better(cand, best) {
				best = cand
			}
			return
		}
		if lmax > best.MaxLateness ||
			(lmax == best.MaxLateness && sumC >= best.TotalCompletion) {
			return
		}
		for j := 0; j < n; j++ {
			if indeg[j] != 0 {
				continue
			}
			s := in.setup(prev, j)
			start := machine + s
			if r := in.Jobs[j].Release; r > start {
				start = r
			}
			end := start + in.Jobs[j].Proc
			nl := lmax
			if late := end - in.Jobs[j].Due; late > nl {
				nl = late
			}
			indeg[j] = -1
			for _, v := range adj[j] {
				indeg[v]--
			}
			order = append(order, j)
			rec(end, j, nl, sumC+end)
			order = order[:len(order)-1]
			for _, v := range adj[j] {
				indeg[v]++
			}
			indeg[j] = 0
		}
	}
	rec(0, -1, math.MinInt64, 0)
	best.Timeline = in.evaluate(best.Order).Timeline
	return best
}

// solveHeuristic runs insertion/swap local search from several deterministic
// starting orders (greedy dispatch plus randomized restarts) and keeps the
// best lexicographic result.
func (in *Instance) solveHeuristic() Solution {
	rng := rand.New(rand.NewSource(1))
	best := in.localSearch(in.greedyOrder())
	for restart := 0; restart < 24; restart++ {
		if s := in.localSearch(in.randomizedGreedy(rng)); better(s, best) {
			best = s
		}
	}
	return best
}

// localSearch improves order with insertion and swap moves until no
// lexicographic improvement exists.
func (in *Instance) localSearch(order []int) Solution {
	best := in.evaluate(order)
	for improved := true; improved; {
		improved = false
		for from := 0; from < len(order); from++ {
			for to := 0; to < len(order); to++ {
				if from == to {
					continue
				}
				cand := moveJob(order, from, to)
				if in.feasibleOrder(cand) {
					if s := in.evaluate(cand); better(s, best) {
						best, order = s, cand
						improved = true
					}
				}
				if from < to {
					cand := swapJobs(order, from, to)
					if !in.feasibleOrder(cand) {
						continue
					}
					if s := in.evaluate(cand); better(s, best) {
						best, order = s, cand
						improved = true
					}
				}
			}
		}
	}
	return best
}

// randomizedGreedy builds a dispatch order that randomly picks among the two
// most attractive ready jobs at each step, diversifying local-search starts.
func (in *Instance) randomizedGreedy(rng *rand.Rand) []int {
	n := len(in.Jobs)
	indeg := make([]int, n)
	adj := make([][]int, n)
	for _, e := range in.Prec {
		indeg[e[1]]++
		adj[e[0]] = append(adj[e[0]], e[1])
	}
	order := make([]int, 0, n)
	machine := int64(0)
	prev := -1
	for len(order) < n {
		type cand struct {
			j    int
			late int64
			end  int64
		}
		var cands []cand
		for j := 0; j < n; j++ {
			if indeg[j] != 0 {
				continue
			}
			start := machine + in.setup(prev, j)
			if r := in.Jobs[j].Release; r > start {
				start = r
			}
			end := start + in.Jobs[j].Proc
			cands = append(cands, cand{j: j, late: end - in.Jobs[j].Due, end: end})
		}
		sort.Slice(cands, func(a, b int) bool {
			if cands[a].late != cands[b].late {
				return cands[a].late < cands[b].late
			}
			if cands[a].end != cands[b].end {
				return cands[a].end < cands[b].end
			}
			return cands[a].j < cands[b].j
		})
		pick := 0
		if len(cands) > 1 {
			pick = rng.Intn(2)
		}
		chosen := cands[pick]
		order = append(order, chosen.j)
		machine = chosen.end
		prev = chosen.j
		indeg[chosen.j] = -1
		for _, v := range adj[chosen.j] {
			indeg[v]--
		}
	}
	return order
}

// swapJobs returns a copy of order with the elements at i and j exchanged.
func swapJobs(order []int, i, j int) []int {
	out := append([]int(nil), order...)
	out[i], out[j] = out[j], out[i]
	return out
}

// greedyOrder appends, at each step, the ready job whose placement yields
// the smallest (lateness, completion, due date, index) tuple.
func (in *Instance) greedyOrder() []int {
	n := len(in.Jobs)
	indeg := make([]int, n)
	adj := make([][]int, n)
	for _, e := range in.Prec {
		indeg[e[1]]++
		adj[e[0]] = append(adj[e[0]], e[1])
	}
	order := make([]int, 0, n)
	machine := int64(0)
	prev := -1
	for len(order) < n {
		chosen := -1
		var bestLate, bestEnd, bestDue int64
		for j := 0; j < n; j++ {
			if indeg[j] != 0 {
				continue
			}
			start := machine + in.setup(prev, j)
			if r := in.Jobs[j].Release; r > start {
				start = r
			}
			end := start + in.Jobs[j].Proc
			late := end - in.Jobs[j].Due
			if chosen < 0 || late < bestLate ||
				(late == bestLate && (end < bestEnd ||
					(end == bestEnd && (in.Jobs[j].Due < bestDue ||
						(in.Jobs[j].Due == bestDue && j < chosen))))) {
				chosen, bestLate, bestEnd, bestDue = j, late, end, in.Jobs[j].Due
			}
		}
		order = append(order, chosen)
		machine = bestEnd
		prev = chosen
		indeg[chosen] = -1
		for _, v := range adj[chosen] {
			indeg[v]--
		}
	}
	return order
}

// moveJob returns a copy of order with the element at from relocated to to.
func moveJob(order []int, from, to int) []int {
	out := make([]int, 0, len(order))
	out = append(out, order[:from]...)
	out = append(out, order[from+1:]...)
	j := order[from]
	out = append(out, 0)
	copy(out[to+1:], out[to:])
	out[to] = j
	return out
}

// feasibleOrder reports whether order is a permutation satisfying every
// precedence edge.
func (in *Instance) feasibleOrder(order []int) bool {
	n := len(in.Jobs)
	if len(order) != n {
		return false
	}
	pos := make([]int, n)
	for i := range pos {
		pos[i] = -1
	}
	for p, j := range order {
		if j < 0 || j >= n || pos[j] != -1 {
			return false
		}
		pos[j] = p
	}
	for _, e := range in.Prec {
		if pos[e[0]] >= pos[e[1]] {
			return false
		}
	}
	return true
}

// Check verifies that sol is a feasible, self-consistent schedule for the
// instance: a valid job permutation, respected precedence, and a timeline
// matching the release/setup/processing rules with the stated objectives.
func (in *Instance) Check(sol Solution) error {
	if !in.feasibleOrder(sol.Order) {
		return fmt.Errorf("sched: order %v is not a precedence-feasible permutation", sol.Order)
	}
	want := in.evaluate(sol.Order)
	if len(sol.Timeline) != len(want.Timeline) {
		return fmt.Errorf("sched: timeline has %d entries, want %d", len(sol.Timeline), len(want.Timeline))
	}
	for i := range want.Timeline {
		if sol.Timeline[i] != want.Timeline[i] {
			return fmt.Errorf("sched: timeline entry %d is %+v, want %+v", i, sol.Timeline[i], want.Timeline[i])
		}
	}
	if sol.MaxLateness != want.MaxLateness || sol.TotalCompletion != want.TotalCompletion {
		return fmt.Errorf("sched: objectives (Lmax=%d, SumC=%d), want (Lmax=%d, SumC=%d)",
			sol.MaxLateness, sol.TotalCompletion, want.MaxLateness, want.TotalCompletion)
	}
	return nil
}

// Render formats the complete timeline: changeovers, idle waits for release
// times, and job intervals, followed by the objective values.
func (in *Instance) Render(sol Solution) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Lmax = %d, SumC = %d\n", sol.MaxLateness, sol.TotalCompletion)
	prev := -1
	for _, p := range sol.Timeline {
		j := in.Jobs[p.Job]
		if p.Setup > 0 {
			fmt.Fprintf(&b, "[%4d, %4d)  setup  cat %d -> cat %d\n",
				p.SetupStart, p.SetupStart+p.Setup, in.Jobs[prev].Category, j.Category)
		}
		if idle := p.Start - (p.SetupStart + p.Setup); idle > 0 {
			fmt.Fprintf(&b, "[%4d, %4d)  idle   (waiting for release of %s)\n",
				p.SetupStart+p.Setup, p.Start, j.ID)
		}
		fmt.Fprintf(&b, "[%4d, %4d)  job    %s (cat %d, due %d, late %d)\n",
			p.Start, p.End, j.ID, j.Category, j.Due, p.End-j.Due)
		prev = p.Job
	}
	return b.String()
}
