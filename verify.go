package flp

import (
	"fmt"
	"math"
)

// Verify independently checks a Result against the instance: every demand is
// assigned whole exactly once to an open site within the coverage limit, no
// capacity is exceeded, the certificates match, and all reported costs are
// recomputed from scratch. It returns nil when the certificate is valid.
func (r Result) Verify(inst Instance) error {
	if err := inst.Validate(); err != nil {
		return err
	}
	if !r.Feasible {
		return fmt.Errorf("flp: cannot verify an infeasible result")
	}
	siteIdx := make(map[string]int, len(inst.Sites))
	for i, s := range inst.Sites {
		siteIdx[s.ID] = i
	}
	demIdx := make(map[string]int, len(inst.Demands))
	for j, d := range inst.Demands {
		demIdx[d.ID] = j
	}
	open := make([]bool, len(inst.Sites))
	openCost := 0.0
	for _, id := range r.OpenSites {
		i, ok := siteIdx[id]
		if !ok {
			return fmt.Errorf("flp: certificate opens unknown site %q", id)
		}
		if open[i] {
			return fmt.Errorf("flp: site %q listed open twice", id)
		}
		open[i] = true
		openCost += inst.Sites[i].OpenCost
	}
	if math.Abs(openCost-r.OpenCost) > Eps {
		return fmt.Errorf("flp: open cost mismatch: certificate %.12g, recomputed %.12g", r.OpenCost, openCost)
	}

	seen := make([]bool, len(inst.Demands))
	used := make([]int, len(inst.Sites))
	distCost := 0.0
	for _, a := range r.Assignments {
		j, ok := demIdx[a.DemandID]
		if !ok {
			return fmt.Errorf("flp: assignment references unknown demand %q", a.DemandID)
		}
		if seen[j] {
			return fmt.Errorf("flp: demand %q assigned more than once (must be indivisible)", a.DemandID)
		}
		seen[j] = true
		i, ok := siteIdx[a.SiteID]
		if !ok {
			return fmt.Errorf("flp: assignment references unknown site %q", a.SiteID)
		}
		if !open[i] {
			return fmt.Errorf("flp: demand %q assigned to site %q which is not open", a.DemandID, a.SiteID)
		}
		d := inst.Demands[j]
		if a.Amount != d.Amount {
			return fmt.Errorf("flp: demand %q split or altered: assigned %d of %d", a.DemandID, a.Amount, d.Amount)
		}
		s := inst.Sites[i]
		dist := dist2pt(s.X, s.Y, d.X, d.Y)
		if dist > inst.MaxDist+Eps {
			return fmt.Errorf("flp: demand %q assigned to site %q at distance %.6g beyond limit %.6g",
				a.DemandID, a.SiteID, dist, inst.MaxDist)
		}
		if math.Abs(dist-a.Dist) > Eps {
			return fmt.Errorf("flp: assignment distance mismatch for demand %q", a.DemandID)
		}
		cost := float64(d.Amount) * dist
		if math.Abs(cost-a.Cost) > Eps {
			return fmt.Errorf("flp: assignment cost mismatch for demand %q", a.DemandID)
		}
		used[i] += d.Amount
		distCost += cost
	}
	for j, d := range inst.Demands {
		if !seen[j] {
			return fmt.Errorf("flp: demand %q is not assigned", d.ID)
		}
	}
	for i, s := range inst.Sites {
		if used[i] > s.Capacity {
			return fmt.Errorf("flp: site %q capacity exceeded: used %d of %d", s.ID, used[i], s.Capacity)
		}
	}
	if math.Abs(distCost-r.DistCost) > Eps {
		return fmt.Errorf("flp: distance cost mismatch: certificate %.12g, recomputed %.12g", r.DistCost, distCost)
	}
	if math.Abs(openCost+distCost-r.TotalCost) > Eps {
		return fmt.Errorf("flp: total cost mismatch: certificate %.12g, recomputed %.12g", r.TotalCost, openCost+distCost)
	}

	certSeen := make([]bool, len(inst.Sites))
	for _, c := range r.Certificates {
		i, ok := siteIdx[c.SiteID]
		if !ok {
			return fmt.Errorf("flp: certificate for unknown site %q", c.SiteID)
		}
		if !open[i] {
			return fmt.Errorf("flp: capacity certificate for site %q which is not open", c.SiteID)
		}
		if certSeen[i] {
			return fmt.Errorf("flp: duplicate capacity certificate for site %q", c.SiteID)
		}
		certSeen[i] = true
		if c.Capacity != inst.Sites[i].Capacity {
			return fmt.Errorf("flp: certificate capacity mismatch for site %q", c.SiteID)
		}
		sum := 0
		for _, id := range c.DemandIDs {
			j, ok := demIdx[id]
			if !ok {
				return fmt.Errorf("flp: certificate of site %q lists unknown demand %q", c.SiteID, id)
			}
			sum += inst.Demands[j].Amount
		}
		if sum != c.Used || c.Used != used[i] {
			return fmt.Errorf("flp: certificate usage mismatch for site %q", c.SiteID)
		}
		if c.Remaining != c.Capacity-c.Used || c.Remaining < 0 {
			return fmt.Errorf("flp: certificate remaining capacity invalid for site %q", c.SiteID)
		}
	}
	return nil
}
