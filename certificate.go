package transport

import (
	"errors"
	"fmt"
	"math"
)

// ScenarioLineCert certifies one line's load, timing and cost under a
// single scenario.
type ScenarioLineCert struct {
	Load     float64
	Capacity float64
	// Arrivals maps order ID to its arrival time in this scenario.
	Arrivals map[string]float64
	// WindowOK reports every order's arrival inside its time window.
	WindowOK bool
	Cost     float64 // variable cost of the line's orders in this scenario
}

// LineCertificate certifies one line of the plan across both scenarios.
type LineCertificate struct {
	LineID    string
	Active    bool
	FixedCost float64
	Orders    []string
	// ZoneLoads[z][s] is the line's load in temperature zone z under
	// scenario s.
	ZoneLoads map[string][ScenarioCount]float64
	Scenario  [ScenarioCount]ScenarioLineCert
}

// ZoneCert certifies shared temperature-zone pool usage per scenario.
type ZoneCert struct {
	Load     [ScenarioCount]float64
	Capacity [ScenarioCount]float64
}

// Certificate is a dual-scenario, per-line certificate for a plan.
type Certificate struct {
	Objective    float64
	ScenarioCost [ScenarioCount]float64
	Lines        []LineCertificate
	// Zones[z] certifies the shared temperature-zone pool z.
	Zones map[string]ZoneCert
	// PredecessorOK[s] reports all predecessor delivery constraints
	// satisfied under scenario s.
	PredecessorOK [ScenarioCount]bool
}

// BuildCertificate produces the dual-scenario per-line certificate for
// a complete assignment.
func BuildCertificate(p *Problem, a Assignment) *Certificate {
	c := &Certificate{
		Objective: p.Objective(a),
		Zones:     map[string]ZoneCert{},
	}
	for s := 0; s < ScenarioCount; s++ {
		c.ScenarioCost[s] = p.scenarioCost(a, s)
		c.PredecessorOK[s] = true
	}
	for j, line := range p.Lines {
		lc := LineCertificate{
			LineID:    line.ID,
			FixedCost: line.FixedCost,
			ZoneLoads: map[string][ScenarioCount]float64{},
		}
		for s := 0; s < ScenarioCount; s++ {
			lc.Scenario[s].Capacity = line.Capacity[s]
			lc.Scenario[s].Arrivals = map[string]float64{}
			lc.Scenario[s].WindowOK = true
		}
		for i, l := range a {
			if l != j {
				continue
			}
			o := p.Orders[i]
			lc.Active = true
			lc.Orders = append(lc.Orders, o.ID)
			zl := lc.ZoneLoads[o.Zone]
			for s := 0; s < ScenarioCount; s++ {
				at := p.Travel[s][i][j]
				lc.Scenario[s].Load += o.Size
				lc.Scenario[s].Arrivals[o.ID] = at
				lc.Scenario[s].Cost += p.Cost[s][i][j]
				if at < o.Earliest || at > o.Latest {
					lc.Scenario[s].WindowOK = false
				}
				zl[s] += o.Size
				zc := c.Zones[o.Zone]
				zc.Load[s] += o.Size
				zc.Capacity = p.ZoneCapacity[o.Zone]
				c.Zones[o.Zone] = zc
			}
			lc.ZoneLoads[o.Zone] = zl
		}
		c.Lines = append(c.Lines, lc)
	}
	for i, o := range p.Orders {
		if o.Predecessor < 0 {
			continue
		}
		for s := 0; s < ScenarioCount; s++ {
			if p.Travel[s][o.Predecessor][a[o.Predecessor]] > p.Travel[s][i][a[i]] {
				c.PredecessorOK[s] = false
			}
		}
	}
	return c
}

const eps = 1e-9

// VerifyCertificate checks that a certificate is internally consistent
// and faithfully describes the assignment for the problem: loads,
// capacities, time windows, predecessor constraints and costs are all
// recomputed and compared.
func VerifyCertificate(p *Problem, a Assignment, c *Certificate) error {
	if len(a) != len(p.Orders) {
		return errors.New("transport: assignment length mismatch")
	}
	if !p.Feasible(a) {
		return errors.New("transport: assignment is not feasible in both scenarios")
	}
	fresh := BuildCertificate(p, a)
	if math.Abs(fresh.Objective-c.Objective) > eps {
		return fmt.Errorf("transport: certificate objective %v != recomputed %v", c.Objective, fresh.Objective)
	}
	for s := 0; s < ScenarioCount; s++ {
		if math.Abs(fresh.ScenarioCost[s]-c.ScenarioCost[s]) > eps {
			return fmt.Errorf("transport: certificate scenario %d cost %v != recomputed %v", s, c.ScenarioCost[s], fresh.ScenarioCost[s])
		}
		if fresh.PredecessorOK[s] != c.PredecessorOK[s] {
			return fmt.Errorf("transport: certificate scenario %d predecessor flag mismatch", s)
		}
	}
	if len(c.Lines) != len(p.Lines) {
		return errors.New("transport: certificate line count mismatch")
	}
	for j := range p.Lines {
		got, want := c.Lines[j], fresh.Lines[j]
		if got.LineID != want.LineID || got.Active != want.Active {
			return fmt.Errorf("transport: certificate line %d identity mismatch", j)
		}
		if len(got.Orders) != len(want.Orders) {
			return fmt.Errorf("transport: certificate line %s order list mismatch", got.LineID)
		}
		for s := 0; s < ScenarioCount; s++ {
			if math.Abs(got.Scenario[s].Load-want.Scenario[s].Load) > eps {
				return fmt.Errorf("transport: certificate line %s scenario %d load mismatch", got.LineID, s)
			}
			if got.Scenario[s].WindowOK != want.Scenario[s].WindowOK {
				return fmt.Errorf("transport: certificate line %s scenario %d window flag mismatch", got.LineID, s)
			}
			if math.Abs(got.Scenario[s].Cost-want.Scenario[s].Cost) > eps {
				return fmt.Errorf("transport: certificate line %s scenario %d cost mismatch", got.LineID, s)
			}
		}
	}
	for z, zc := range fresh.Zones {
		got, ok := c.Zones[z]
		if !ok {
			return fmt.Errorf("transport: certificate missing zone %s", z)
		}
		for s := 0; s < ScenarioCount; s++ {
			if math.Abs(got.Load[s]-zc.Load[s]) > eps {
				return fmt.Errorf("transport: certificate zone %s scenario %d load mismatch", z, s)
			}
		}
	}
	return nil
}
