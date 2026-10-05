package transport

// Assignment maps order index -> line index. Every order is assigned to
// exactly one line: orders are indivisible.
type Assignment []int

// scenarioCost returns the total cost of a complete assignment under
// scenario s: activated line fixed costs plus variable costs.
func (p *Problem) scenarioCost(a Assignment, s int) float64 {
	active := make([]bool, len(p.Lines))
	total := 0.0
	for i, l := range a {
		total += p.Cost[s][i][l]
		active[l] = true
	}
	for j, on := range active {
		if on {
			total += p.Lines[j].FixedCost
		}
	}
	return total
}

// Objective returns the minimax objective: the larger of the two
// scenario costs.
func (p *Problem) Objective(a Assignment) float64 {
	c0 := p.scenarioCost(a, 0)
	c1 := p.scenarioCost(a, 1)
	if c1 > c0 {
		return c1
	}
	return c0
}

// Feasible reports whether a complete assignment satisfies every
// constraint in both scenarios: per-line capacities, shared
// temperature-zone capacities, delivery time windows and predecessor
// delivery constraints.
func (p *Problem) Feasible(a Assignment) bool {
	load := make([][ScenarioCount]float64, len(p.Lines))
	zoneLoad := map[string][ScenarioCount]float64{}
	for i, l := range a {
		o := p.Orders[i]
		for s := 0; s < ScenarioCount; s++ {
			load[l][s] += o.Size
			zoneLoad[o.Zone] = addScenario(zoneLoad[o.Zone], s, o.Size)
			// Time window must hold in each scenario.
			at := p.Travel[s][i][l]
			if at < o.Earliest || at > o.Latest {
				return false
			}
		}
	}
	for j := range p.Lines {
		for s := 0; s < ScenarioCount; s++ {
			if load[j][s] > p.Lines[j].Capacity[s] {
				return false
			}
		}
	}
	for z, cap := range p.ZoneCapacity {
		zl := zoneLoad[z]
		for s := 0; s < ScenarioCount; s++ {
			if zl[s] > cap[s] {
				return false
			}
		}
	}
	// Predecessor delivery constraints, per scenario.
	for i, o := range p.Orders {
		if o.Predecessor < 0 {
			continue
		}
		for s := 0; s < ScenarioCount; s++ {
			if p.Travel[s][o.Predecessor][a[o.Predecessor]] > p.Travel[s][i][a[i]] {
				return false
			}
		}
	}
	return true
}

func addScenario(v [ScenarioCount]float64, s int, x float64) [ScenarioCount]float64 {
	v[s] += x
	return v
}
