// Package sched assigns up to 16 shifts to exactly 4 employees at minimum
// cost, subject to skill compatibility, a per-employee total-hours cap and a
// minimum rest gap between adjacent shifts of the same employee. The cost
// model combines a changeover penalty for handing consecutive shifts to
// different employees with a tiered (overtime-ladder) labor rate.
package sched

import (
	"container/heap"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
)

// ErrInfeasible is returned by Solve when no assignment satisfies every
// constraint.
var ErrInfeasible = errors.New("sched: no feasible assignment")

// Tier is one rung of the overtime ladder: the first UpTo minutes of an
// employee's total are charged Rate per minute. The last tier must have
// UpTo < 0, meaning unbounded.
type Tier struct {
	UpTo int
	Rate int
}

// Shift is a single unit of work. Times are minutes from a common origin.
// An empty Skill matches every employee.
type Shift struct {
	ID    string
	Start int
	End   int
	Skill string
}

// Employee describes one of the four workers. MaxHours is a cap on total
// assigned minutes despite its name.
type Employee struct {
	ID       string
	Skills   []string
	MaxHours int
}

// Params bundles the cost model and the rest constraint.
type Params struct {
	Tiers      []Tier // overtime ladder, last tier unbounded
	Changeover int    // penalty when adjacent shifts switch employee
	MinRest    int    // minutes required between one employee's adjacent shifts
}

// Instance is a full scheduling problem: at most 16 shifts, 4 employees.
type Instance struct {
	Shifts    []Shift
	Employees [4]Employee
	Params    Params
}

// Solution is the minimum-cost assignment produced by Solve.
type Solution struct {
	Assign      []int // employee index per shift, same order as Instance.Shifts
	Minutes     [4]int
	Labor       [4]int
	Changeovers int
	Total       int
}

func (e *Employee) hasSkill(skill string) bool {
	if skill == "" {
		return true
	}
	for _, s := range e.Skills {
		if s == skill {
			return true
		}
	}
	return false
}

// labor returns the tiered cost of mins total minutes.
func labor(mins int, tiers []Tier) int {
	cost, prev := 0, 0
	for _, t := range tiers {
		hi := t.UpTo
		if hi < 0 || hi > mins {
			hi = mins
		}
		if hi > prev {
			cost += (hi - prev) * t.Rate
		}
		prev = hi
		if prev >= mins {
			break
		}
	}
	return cost
}

func (inst *Instance) validate() error {
	n := len(inst.Shifts)
	if n == 0 || n > 16 {
		return fmt.Errorf("sched: need 1..16 shifts, got %d", n)
	}
	for i, sh := range inst.Shifts {
		if sh.End <= sh.Start {
			return fmt.Errorf("sched: shift %q has non-positive duration", sh.ID)
		}
		if i > 0 && sh.Start < inst.Shifts[i-1].Start {
			return fmt.Errorf("sched: shifts must be sorted by start time (%q)", sh.ID)
		}
	}
	p := inst.Params
	if len(p.Tiers) == 0 {
		return fmt.Errorf("sched: at least one cost tier required")
	}
	for i, t := range p.Tiers {
		if t.Rate < 0 {
			return fmt.Errorf("sched: negative rate in tier %d", i)
		}
		if i > 0 && t.Rate < p.Tiers[i-1].Rate {
			return fmt.Errorf("sched: tier rates must be non-decreasing (overtime ladder)")
		}
		if i < len(p.Tiers)-1 {
			if t.UpTo < 0 || (i > 0 && t.UpTo <= p.Tiers[i-1].UpTo) {
				return fmt.Errorf("sched: tier %d bounds must be positive and increasing", i)
			}
		} else if t.UpTo >= 0 {
			return fmt.Errorf("sched: last tier must be unbounded (UpTo < 0)")
		}
	}
	if p.MinRest < 0 || p.Changeover < 0 {
		return fmt.Errorf("sched: MinRest and Changeover must be non-negative")
	}
	return nil
}

// node is one A* search node. After assigning the first i shifts it
// records, per employee, the total assigned minutes and the end time of
// the employee's last shift (-1 when still unused), which employee took
// the previous shift (for the changeover penalty), the accumulated cost
// g, and the priority f = g + h. parent and emp link back so the optimal
// assignment can be reconstructed.
type node struct {
	mins   [4]int32
	ends   [4]int32
	i      int32
	last   int32
	g      int
	f      int
	parent int32
	emp    int32
}

// akey identifies nodes that are interchangeable for the remainder of the
// search; only the cheapest copy is expanded.
type akey struct {
	mins [4]int32
	ends [4]int32
	i    int32
	last int32
}

// prio is a min-heap of node indices ordered by f (ties broken by g).
type prio struct {
	nodes *[]node
	idx   []int32
}

func (p prio) Len() int { return len(p.idx) }
func (p prio) Less(a, b int) bool {
	x, y := (*p.nodes)[p.idx[a]], (*p.nodes)[p.idx[b]]
	if x.f != y.f {
		return x.f < y.f
	}
	return x.g > y.g
}
func (p prio) Swap(a, b int) { p.idx[a], p.idx[b] = p.idx[b], p.idx[a] }
func (p *prio) Push(x any)   { p.idx = append(p.idx, x.(int32)) }
func (p *prio) Pop() (v any) { old := p.idx; v = old[len(old)-1]; p.idx = old[:len(old)-1]; return v }

// lowerBound returns an admissible lower bound on the additional labor
// cost needed to place the remaining R minutes, plus ok=false if the
// remaining minutes provably exceed the total remaining hours caps (an
// exact infeasibility test). Because tier rates are non-decreasing, the
// relaxation that allows splitting shift durations fractionally across
// employees is solved exactly by greedily filling the cheapest remaining
// tier capacity. Changeover costs are ignored (>= 0), so the bound is
// consistent: h(s) <= stepCost(s,s') + h(s') for every arc s->s'.
func (inst *Instance) lowerBound(mins [4]int32, rest int) (int, bool) {
	type seg struct{ rate, avail int }
	var segs []seg
	totalCap := 0
	for e := 0; e < 4; e++ {
		rem := inst.Employees[e].MaxHours - int(mins[e])
		totalCap += rem
		m, lo := int(mins[e]), 0
		for _, t := range inst.Params.Tiers {
			if rem <= 0 {
				break
			}
			hi := t.UpTo
			if hi < 0 {
				hi = math.MaxInt32
			}
			start := lo
			if m > start {
				start = m
			}
			if start < hi {
				avail := hi - start
				if avail > rem {
					avail = rem
				}
				segs = append(segs, seg{t.Rate, avail})
				rem -= avail
			}
			lo = hi
		}
	}
	if rest > totalCap {
		return 0, false
	}
	sort.Slice(segs, func(a, b int) bool { return segs[a].rate < segs[b].rate })
	h := 0
	for _, s := range segs {
		if rest == 0 {
			break
		}
		take := s.avail
		if take > rest {
			take = rest
		}
		h += take * s.rate
		rest -= take
	}
	return h, true
}

// Solve finds the minimum-cost feasible assignment with A* over the shift
// sequence, using the convex tier lower bound above. It returns
// ErrInfeasible when the constraints cannot all be met.
func (inst *Instance) Solve() (Solution, error) {
	if err := inst.validate(); err != nil {
		return Solution{}, err
	}
	n := len(inst.Shifts)
	tiers := inst.Params.Tiers
	suffix := make([]int, n+1)
	for i := n - 1; i >= 0; i-- {
		suffix[i] = suffix[i+1] + inst.Shifts[i].End - inst.Shifts[i].Start
	}
	nodes := make([]node, 1, 1024)
	for e := range nodes[0].ends {
		nodes[0].ends[e] = -1
	}
	nodes[0].last, nodes[0].parent, nodes[0].emp = -1, -1, -1
	h0, ok := inst.lowerBound(nodes[0].mins, suffix[0])
	if !ok {
		return Solution{}, ErrInfeasible
	}
	nodes[0].f = h0
	pq := &prio{nodes: &nodes, idx: []int32{0}}
	best := make(map[akey]int)
	goal := int32(-1)
	for pq.Len() > 0 {
		cur := heap.Pop(pq).(int32)
		nd := nodes[cur]
		k := akey{mins: nd.mins, ends: nd.ends, i: nd.i, last: nd.last}
		if bg, seen := best[k]; seen && bg < nd.g {
			continue
		}
		if int(nd.i) == n {
			goal = cur
			break
		}
		sh := inst.Shifts[nd.i]
		d := sh.End - sh.Start
		for e := 0; e < 4; e++ {
			emp := &inst.Employees[e]
			if !emp.hasSkill(sh.Skill) {
				continue
			}
			if nd.ends[e] >= 0 && sh.Start-int(nd.ends[e]) < inst.Params.MinRest {
				continue
			}
			m := int(nd.mins[e])
			if m+d > emp.MaxHours {
				continue
			}
			g := nd.g + labor(m+d, tiers) - labor(m, tiers)
			if nd.last >= 0 && int(nd.last) != e {
				g += inst.Params.Changeover
			}
			nn := node{
				mins:   nd.mins,
				ends:   nd.ends,
				i:      nd.i + 1,
				last:   int32(e),
				g:      g,
				parent: cur,
				emp:    int32(e),
			}
			nn.mins[e] = int32(m + d)
			nn.ends[e] = int32(sh.End)
			h, ok := inst.lowerBound(nn.mins, suffix[nd.i+1])
			if !ok {
				continue
			}
			nn.f = g + h
			ck := akey{mins: nn.mins, ends: nn.ends, i: nn.i, last: nn.last}
			if bg, seen := best[ck]; seen && bg <= g {
				continue
			}
			best[ck] = g
			nodes = append(nodes, nn)
			heap.Push(pq, int32(len(nodes)-1))
		}
	}
	if goal < 0 {
		return Solution{}, ErrInfeasible
	}
	sol := Solution{Assign: make([]int, n), Total: nodes[goal].g}
	for idx := goal; nodes[idx].parent >= 0; idx = nodes[idx].parent {
		sol.Assign[nodes[idx].i-1] = int(nodes[idx].emp)
	}
	for i, sh := range inst.Shifts {
		e := sol.Assign[i]
		sol.Minutes[e] += sh.End - sh.Start
		if i > 0 && sol.Assign[i-1] != e {
			sol.Changeovers++
		}
	}
	for e := 0; e < 4; e++ {
		sol.Labor[e] = labor(sol.Minutes[e], tiers)
	}
	return sol, nil
}

// Report renders the minimum-cost table followed by the per-employee
// certificate, as produced by Verify.
func (inst *Instance) Report(sol *Solution) (string, error) {
	cert, err := Verify(inst, sol)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString("shift  span        skill  assignee\n")
	for i, sh := range inst.Shifts {
		fmt.Fprintf(&b, "%-6s %-11s %-6s %s\n",
			sh.ID, fmt.Sprintf("%d-%d", sh.Start, sh.End), orDash(sh.Skill),
			inst.Employees[sol.Assign[i]].ID)
	}
	fmt.Fprintf(&b, "\nemployee  minutes  cap   labor\n")
	for e := 0; e < 4; e++ {
		fmt.Fprintf(&b, "%-9s %-8d %-5d %d\n",
			inst.Employees[e].ID, sol.Minutes[e], inst.Employees[e].MaxHours, sol.Labor[e])
	}
	fmt.Fprintf(&b, "changeovers: %d x %d = %d\n", sol.Changeovers, inst.Params.Changeover,
		sol.Changeovers*inst.Params.Changeover)
	fmt.Fprintf(&b, "total: %d\n\n", sol.Total)
	b.WriteString(cert.String())
	return b.String(), nil
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}
