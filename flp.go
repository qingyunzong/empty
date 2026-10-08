// Package flp solves a small capacitated facility location problem exactly:
// choose a subset of candidate sites to open and assign each demand
// indivisibly to an open site within a coverage distance limit, minimizing
// total opening cost plus distance cost (demand amount times distance).
package flp

import (
	"errors"
	"fmt"
	"math"
	"sort"
)

// Eps is the tolerance used for all floating point comparisons.
const Eps = 1e-9

// MaxSites and MaxDemands bound the instance size the exact solver accepts.
const (
	MaxSites   = 18
	MaxDemands = 12
)

// Site is a candidate facility location with an integer capacity.
type Site struct {
	ID       string  `json:"id"`
	OpenCost float64 `json:"open_cost"`
	Capacity int     `json:"capacity"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
}

// Demand is an indivisible demand of integer amount located at (X, Y).
type Demand struct {
	ID     string  `json:"id"`
	Amount int     `json:"amount"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
}

// Instance is a full problem instance. MaxDist is the coverage distance
// limit: a demand may only be assigned to a site within this distance.
type Instance struct {
	Sites   []Site   `json:"sites"`
	Demands []Demand `json:"demands"`
	MaxDist float64  `json:"max_dist"`
}

// Assignment records that a full demand is served by one site.
type Assignment struct {
	DemandID string  `json:"demand_id"`
	SiteID   string  `json:"site_id"`
	Amount   int     `json:"amount"`
	Dist     float64 `json:"dist"`
	Cost     float64 `json:"cost"`
}

// SiteCertificate proves capacity feasibility for one open site.
type SiteCertificate struct {
	SiteID    string   `json:"site_id"`
	Capacity  int      `json:"capacity"`
	Used      int      `json:"used"`
	Remaining int      `json:"remaining"`
	DemandIDs []string `json:"demand_ids"`
}

// Result is the solver output, including the capacity certificate and,
// when a finite budget is supplied, the budget bound verdict.
type Result struct {
	Feasible     bool              `json:"feasible"`
	OpenSites    []string          `json:"open_sites,omitempty"`
	Assignments  []Assignment      `json:"assignments,omitempty"`
	Certificates []SiteCertificate `json:"certificates,omitempty"`
	OpenCost     float64           `json:"open_cost"`
	DistCost     float64           `json:"dist_cost"`
	TotalCost    float64           `json:"total_cost"`
	// LowerBound is a certified lower bound on the optimal total cost,
	// valid even when the instance is infeasible to solve to optimality.
	LowerBound float64 `json:"lower_bound"`
	// Budget is the input budget; negative means no budget was given.
	Budget float64 `json:"budget"`
	// BudgetOK reports whether the optimal cost fits the budget. When
	// false and Budget >= 0, LowerBound certifies the budget is too small
	// if LowerBound > Budget.
	BudgetOK bool   `json:"budget_ok"`
	Reason   string `json:"reason,omitempty"`
}

// Validate checks structural constraints of the instance.
func (inst Instance) Validate() error {
	if len(inst.Sites) == 0 && len(inst.Demands) > 0 {
		return errors.New("flp: demands present but no sites")
	}
	if len(inst.Sites) > MaxSites {
		return fmt.Errorf("flp: %d sites exceed limit %d", len(inst.Sites), MaxSites)
	}
	if len(inst.Demands) > MaxDemands {
		return fmt.Errorf("flp: %d demands exceed limit %d", len(inst.Demands), MaxDemands)
	}
	if inst.MaxDist < 0 {
		return errors.New("flp: max_dist must be non-negative")
	}
	seen := map[string]bool{}
	for _, s := range inst.Sites {
		if s.ID == "" {
			return errors.New("flp: site with empty id")
		}
		if seen[s.ID] {
			return fmt.Errorf("flp: duplicate site id %q", s.ID)
		}
		seen[s.ID] = true
		if s.Capacity < 0 {
			return fmt.Errorf("flp: site %q has negative capacity", s.ID)
		}
		if s.OpenCost < 0 {
			return fmt.Errorf("flp: site %q has negative open cost", s.ID)
		}
	}
	seen = map[string]bool{}
	for _, d := range inst.Demands {
		if d.ID == "" {
			return errors.New("flp: demand with empty id")
		}
		if seen[d.ID] {
			return fmt.Errorf("flp: duplicate demand id %q", d.ID)
		}
		seen[d.ID] = true
		if d.Amount <= 0 {
			return fmt.Errorf("flp: demand %q has non-positive amount", d.ID)
		}
	}
	return nil
}

func dist2pt(ax, ay, bx, by float64) float64 {
	return math.Hypot(ax-bx, ay-by)
}

// geometry precomputes distances and coverage between sites and demands.
type geometry struct {
	dist  [][]float64 // dist[site][demand]
	cover [][]bool    // cover[site][demand]
}

func newGeometry(inst Instance) geometry {
	n, m := len(inst.Sites), len(inst.Demands)
	g := geometry{dist: make([][]float64, n), cover: make([][]bool, n)}
	for i, s := range inst.Sites {
		g.dist[i] = make([]float64, m)
		g.cover[i] = make([]bool, m)
		for j, d := range inst.Demands {
			g.dist[i][j] = dist2pt(s.X, s.Y, d.X, d.Y)
			g.cover[i][j] = g.dist[i][j] <= inst.MaxDist+Eps
		}
	}
	return g
}

// Solve exactly solves the instance. A negative budget means "no budget";
// otherwise the result reports whether the optimal cost fits the budget and
// carries a certified lower bound.
func Solve(inst Instance, budget float64) (Result, error) {
	if err := inst.Validate(); err != nil {
		return Result{}, err
	}
	res := Result{Budget: budget, BudgetOK: budget < 0}
	m := len(inst.Demands)
	if m == 0 {
		res.Feasible = true
		res.BudgetOK = budget < 0 || 0 <= budget+Eps
		return res, nil
	}
	n := len(inst.Sites)
	g := newGeometry(inst)

	// Any demand uncovered by every site makes the instance infeasible.
	for j := range inst.Demands {
		covered := false
		for i := range inst.Sites {
			if g.cover[i][j] {
				covered = true
				break
			}
		}
		if !covered {
			res.Reason = fmt.Sprintf("demand %q is beyond the coverage limit of every site", inst.Demands[j].ID)
			res.LowerBound = math.Inf(1)
			return res, nil
		}
	}

	best := math.Inf(1)
	var bestMask uint64
	var bestAssign []int
	globalLB := math.Inf(1)

	for mask := uint64(1); mask < uint64(1)<<uint(n); mask++ {
		var open []int
		openCost := 0.0
		for i := 0; i < n; i++ {
			if mask>>uint(i)&1 == 1 {
				open = append(open, i)
				openCost += inst.Sites[i].OpenCost
			}
		}
		if openCost >= best-Eps {
			continue
		}
		// Relaxation: ignore capacities, each demand takes its nearest
		// covering open site. This is a valid lower bound for this mask.
		minDist := make([]float64, m)
		relax := openCost
		feasibleCover := true
		for j := range inst.Demands {
			d := math.Inf(1)
			for _, i := range open {
				if g.cover[i][j] && g.dist[i][j] < d {
					d = g.dist[i][j]
				}
			}
			if math.IsInf(d, 1) {
				feasibleCover = false
				break
			}
			minDist[j] = d
			relax += float64(inst.Demands[j].Amount) * d
		}
		if !feasibleCover {
			continue
		}
		if relax < globalLB {
			globalLB = relax
		}
		if relax >= best-Eps {
			continue
		}
		distCost, assign, ok := exactAssign(inst, g, open, minDist, best-openCost)
		if !ok {
			continue
		}
		if total := openCost + distCost; total < best-Eps {
			best = total
			bestMask = mask
			bestAssign = assign
		}
	}

	res.LowerBound = globalLB
	if math.IsInf(best, 1) {
		res.Reason = "no feasible assignment: capacities or coverage too tight"
		return res, nil
	}

	res.Feasible = true
	res.TotalCost = best
	used := make([]int, n)
	for i := 0; i < n; i++ {
		if bestMask>>uint(i)&1 == 1 {
			res.OpenSites = append(res.OpenSites, inst.Sites[i].ID)
			res.OpenCost += inst.Sites[i].OpenCost
		}
	}
	res.DistCost = best - res.OpenCost
	for j, si := range bestAssign {
		d := inst.Demands[j]
		used[si] += d.Amount
		res.Assignments = append(res.Assignments, Assignment{
			DemandID: d.ID,
			SiteID:   inst.Sites[si].ID,
			Amount:   d.Amount,
			Dist:     g.dist[si][j],
			Cost:     float64(d.Amount) * g.dist[si][j],
		})
	}
	for i := 0; i < n; i++ {
		if bestMask>>uint(i)&1 == 0 {
			continue
		}
		cert := SiteCertificate{
			SiteID:    inst.Sites[i].ID,
			Capacity:  inst.Sites[i].Capacity,
			Used:      used[i],
			Remaining: inst.Sites[i].Capacity - used[i],
		}
		for _, a := range res.Assignments {
			if a.SiteID == inst.Sites[i].ID {
				cert.DemandIDs = append(cert.DemandIDs, a.DemandID)
			}
		}
		res.Certificates = append(res.Certificates, cert)
	}
	if budget >= 0 {
		res.BudgetOK = best <= budget+Eps
		if !res.BudgetOK {
			res.Reason = fmt.Sprintf("optimal cost %.6g exceeds budget %.6g (lower bound %.6g)", best, budget, globalLB)
		}
	}
	return res, nil
}

// exactAssign finds the minimum distance cost indivisible assignment of all
// demands to the given open sites, respecting integer capacities. It only
// searches for solutions strictly cheaper than limit. It returns the
// assignment as a site index per demand.
func exactAssign(inst Instance, g geometry, open []int, minDist []float64, limit float64) (float64, []int, bool) {
	m := len(inst.Demands)
	order := make([]int, m)
	for j := range order {
		order[j] = j
	}
	sort.Slice(order, func(a, b int) bool {
		return inst.Demands[order[a]].Amount > inst.Demands[order[b]].Amount
	})
	// suffix[k] bounds the remaining distance cost from below.
	suffix := make([]float64, m+1)
	for k := m - 1; k >= 0; k-- {
		suffix[k] = suffix[k+1] + float64(inst.Demands[order[k]].Amount)*minDist[order[k]]
	}
	rem := make([]int, len(open))
	for i, s := range open {
		rem[i] = inst.Sites[s].Capacity
	}
	best := limit
	bestAssign := make([]int, m)
	cur := make([]int, m)
	found := false
	var rec func(k int, cost float64)
	rec = func(k int, cost float64) {
		if cost+suffix[k] >= best-Eps {
			return
		}
		if k == m {
			best = cost
			copy(bestAssign, cur)
			found = true
			return
		}
		j := order[k]
		amt := inst.Demands[j].Amount
		for i, s := range open {
			if !g.cover[s][j] || rem[i] < amt {
				continue
			}
			rem[i] -= amt
			cur[j] = s
			rec(k+1, cost+float64(amt)*g.dist[s][j])
			rem[i] += amt
		}
	}
	rec(0, 0)
	return best, bestAssign, found
}

// AssignOptimal solves the assignment subproblem with a fixed set of open
// sites (open[i] true means site i is open). It is useful for verifying
// assignments on fully open instances.
func AssignOptimal(inst Instance, open []bool) (Result, error) {
	if err := inst.Validate(); err != nil {
		return Result{}, err
	}
	if len(open) != len(inst.Sites) {
		return Result{}, errors.New("flp: open mask length must equal number of sites")
	}
	res := Result{Budget: -1, BudgetOK: true}
	m := len(inst.Demands)
	g := newGeometry(inst)
	var openIdx []int
	openCost := 0.0
	for i, o := range open {
		if o {
			openIdx = append(openIdx, i)
			openCost += inst.Sites[i].OpenCost
			res.OpenSites = append(res.OpenSites, inst.Sites[i].ID)
		}
	}
	res.OpenCost = openCost
	if m == 0 {
		res.Feasible = true
		res.TotalCost = openCost
		return res, nil
	}
	minDist := make([]float64, m)
	for j := range inst.Demands {
		d := math.Inf(1)
		for _, i := range openIdx {
			if g.cover[i][j] && g.dist[i][j] < d {
				d = g.dist[i][j]
			}
		}
		if math.IsInf(d, 1) {
			res.Reason = fmt.Sprintf("demand %q uncovered by open sites", inst.Demands[j].ID)
			res.LowerBound = math.Inf(1)
			return res, nil
		}
		minDist[j] = d
	}
	distCost, assign, ok := exactAssign(inst, g, openIdx, minDist, math.Inf(1))
	if !ok {
		res.Reason = "no feasible assignment for the fixed open set"
		res.LowerBound = math.Inf(1)
		return res, nil
	}
	res.Feasible = true
	res.DistCost = distCost
	res.TotalCost = openCost + distCost
	res.LowerBound = res.TotalCost
	used := make([]int, len(inst.Sites))
	for j, si := range assign {
		d := inst.Demands[j]
		used[si] += d.Amount
		res.Assignments = append(res.Assignments, Assignment{
			DemandID: d.ID,
			SiteID:   inst.Sites[si].ID,
			Amount:   d.Amount,
			Dist:     g.dist[si][j],
			Cost:     float64(d.Amount) * g.dist[si][j],
		})
	}
	for _, i := range openIdx {
		cert := SiteCertificate{
			SiteID:    inst.Sites[i].ID,
			Capacity:  inst.Sites[i].Capacity,
			Used:      used[i],
			Remaining: inst.Sites[i].Capacity - used[i],
		}
		for _, a := range res.Assignments {
			if a.SiteID == inst.Sites[i].ID {
				cert.DemandIDs = append(cert.DemandIDs, a.DemandID)
			}
		}
		res.Certificates = append(res.Certificates, cert)
	}
	return res, nil
}
