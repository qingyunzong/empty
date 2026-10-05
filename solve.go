package transport

import (
	"errors"
	"math"
)

// FrontierPoint is one non-dominated complete plan observed during the
// search, expressed in the two scenario-cost dimensions.
type FrontierPoint struct {
	ScenarioCost [ScenarioCount]float64
	Objective    float64
}

// Trace records the search frontier and the best bounds seen.
type Trace struct {
	NodesExplored int
	NodesPruned   int
	// Frontier holds the Pareto frontier (minimizing both scenario
	// costs) of all feasible complete plans found so far.
	Frontier []FrontierPoint
	// BestUpper is the incumbent objective value (best plan found).
	BestUpper float64
	// BestLower is the smallest lower bound among all nodes that were
	// pruned or fully evaluated. When the search runs to completion it
	// equals the optimum, certifying BestUpper.
	BestLower float64
}

// Result is the outcome of Solve.
type Result struct {
	Assignment   Assignment
	Objective    float64
	ScenarioCost [ScenarioCount]float64
	Certificate  *Certificate
	Trace        Trace
}

// ErrInfeasible is returned when no assignment satisfies both scenarios.
var ErrInfeasible = errors.New("transport: no assignment feasible in both scenarios")

// Solve finds a fixed assignment minimizing the larger of the two
// scenario costs via branch and bound. The search records a Pareto
// frontier of feasible plans plus best upper/lower bounds in the trace.
func Solve(p *Problem) (*Result, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	n := len(p.Orders)
	s := &solver{
		p:         p,
		assign:    make(Assignment, n),
		load:      make([][ScenarioCount]float64, len(p.Lines)),
		zoneLoad:  map[string][ScenarioCount]float64{},
		active:    make([]int, len(p.Lines)),
		bestUpper: math.Inf(1),
		bestLower: math.Inf(1),
	}
	s.search(0, 0, 0)

	if s.bestAssign == nil {
		return nil, ErrInfeasible
	}
	res := &Result{
		Assignment: s.bestAssign,
		Objective:  s.bestUpper,
		Trace: Trace{
			NodesExplored: s.nodesExplored,
			NodesPruned:   s.nodesPruned,
			Frontier:      s.frontier,
			BestUpper:     s.bestUpper,
			BestLower:     s.bestLower,
		},
	}
	res.ScenarioCost[0] = p.scenarioCost(res.Assignment, 0)
	res.ScenarioCost[1] = p.scenarioCost(res.Assignment, 1)
	res.Certificate = BuildCertificate(p, res.Assignment)
	return res, nil
}

type solver struct {
	p             *Problem
	assign        Assignment
	bestAssign    Assignment
	load          [][ScenarioCount]float64
	zoneLoad      map[string][ScenarioCount]float64
	active        []int // number of orders currently on each line
	bestUpper     float64
	bestLower     float64
	frontier      []FrontierPoint
	nodesExplored int
	nodesPruned   int
}

// search assigns orders [i, n) depth-first. cost0/cost1 are the
// scenario costs accumulated so far (variable + activated fixed costs).
func (s *solver) search(i int, cost0, cost1 float64) {
	s.nodesExplored++
	// Lower bound: scenario costs are monotone non-decreasing as more
	// orders are assigned, so the current max bounds every completion.
	lb := math.Max(cost0, cost1)
	if lb >= s.bestUpper {
		s.nodesPruned++
		if lb < s.bestLower {
			s.bestLower = lb
		}
		return
	}
	p := s.p
	if i == len(p.Orders) {
		// Complete assignment: check predecessor constraints (the only
		// constraints not verified incrementally).
		if !s.predecessorsOK() {
			return
		}
		if lb < s.bestLower {
			s.bestLower = lb
		}
		s.record(cost0, cost1)
		return
	}
	o := p.Orders[i]
	for j := range p.Lines {
		// Incremental feasibility: line capacity, shared zone capacity
		// and the order's time window, each in both scenarios.
		ok := true
		for sc := 0; sc < ScenarioCount && ok; sc++ {
			if s.load[j][sc]+o.Size > p.Lines[j].Capacity[sc] {
				ok = false
				break
			}
			if cap, has := p.ZoneCapacity[o.Zone]; has {
				if s.zoneLoad[o.Zone][sc]+o.Size > cap[sc] {
					ok = false
					break
				}
			}
			at := p.Travel[sc][i][j]
			if at < o.Earliest || at > o.Latest {
				ok = false
			}
		}
		if !ok {
			continue
		}
		// Apply.
		fixed := 0.0
		if s.active[j] == 0 {
			fixed = p.Lines[j].FixedCost
		}
		s.active[j]++
		s.assign[i] = j
		zl := s.zoneLoad[o.Zone]
		for sc := 0; sc < ScenarioCount; sc++ {
			s.load[j][sc] += o.Size
			zl[sc] += o.Size
		}
		s.zoneLoad[o.Zone] = zl

		s.search(i+1, cost0+p.Cost[0][i][j]+fixed, cost1+p.Cost[1][i][j]+fixed)

		// Undo.
		for sc := 0; sc < ScenarioCount; sc++ {
			s.load[j][sc] -= o.Size
			zl[sc] -= o.Size
		}
		s.zoneLoad[o.Zone] = zl
		s.active[j]--
	}
}

// predecessorsOK checks predecessor delivery constraints for a complete
// assignment in both scenarios.
func (s *solver) predecessorsOK() bool {
	p := s.p
	for i, o := range p.Orders {
		if o.Predecessor < 0 {
			continue
		}
		for sc := 0; sc < ScenarioCount; sc++ {
			if p.Travel[sc][o.Predecessor][s.assign[o.Predecessor]] > p.Travel[sc][i][s.assign[i]] {
				return false
			}
		}
	}
	return true
}

// record stores a feasible complete plan: updates the incumbent and the
// Pareto frontier.
func (s *solver) record(cost0, cost1 float64) {
	obj := math.Max(cost0, cost1)
	if obj < s.bestUpper {
		s.bestUpper = obj
		s.bestAssign = append(Assignment(nil), s.assign...)
	}
	// Pareto frontier maintenance in (cost0, cost1) space.
	pt := FrontierPoint{ScenarioCost: [ScenarioCount]float64{cost0, cost1}, Objective: obj}
	for _, q := range s.frontier {
		if q.ScenarioCost[0] <= cost0 && q.ScenarioCost[1] <= cost1 {
			return // dominated by an existing point
		}
	}
	kept := s.frontier[:0]
	for _, q := range s.frontier {
		if cost0 <= q.ScenarioCost[0] && cost1 <= q.ScenarioCost[1] {
			continue // q is dominated by the new point
		}
		kept = append(kept, q)
	}
	s.frontier = append(kept, pt)
}
