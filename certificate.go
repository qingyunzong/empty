package transport

// LineCertificate records the per-line, per-scenario evidence for one line
// under a fixed assignment.
type LineCertificate struct {
	LineID    int
	Zone      int
	Used      bool
	Orders    []int          // assigned order IDs
	Load      [Scenarios]int // total demand per scenario
	Capacity  [Scenarios]int // public capacity per scenario
	Arrival   [Scenarios]int // arrival time per scenario
	FixedCost int            // activation cost (0 contribution when unused)
}

// Certificate is a dual-scenario capacity certificate for one fixed
// assignment: it proves (or disproves) feasibility in both public scenarios
// at once and reports both scenario costs.
type Certificate struct {
	Assignment []int // assignment[o] = line index
	Lines      []LineCertificate
	ZoneLoad   []int // shared temperature-zone usage
	ZoneCap    []int
	Cost       [Scenarios]int
	Objective  int
	Feasible   bool
	Violations []string
}

// Certify builds and verifies the dual-scenario certificate of an assignment.
func (p *Problem) Certify(a []int) Certificate {
	cert := Certificate{
		Assignment: append([]int(nil), a...),
		Lines:      make([]LineCertificate, len(p.Lines)),
		ZoneLoad:   make([]int, len(p.ZoneCap)),
		ZoneCap:    append([]int(nil), p.ZoneCap...),
	}
	for l, ln := range p.Lines {
		cert.Lines[l] = LineCertificate{
			LineID:    ln.ID,
			Zone:      ln.Zone,
			Capacity:  ln.Capacity,
			Arrival:   ln.Travel,
			FixedCost: ln.FixedCost,
		}
	}
	for o, l := range a {
		ord := &p.Orders[o]
		lc := &cert.Lines[l]
		lc.Used = true
		lc.Orders = append(lc.Orders, ord.ID)
		cert.ZoneLoad[ord.Zone] += ord.Demand
		for s := 0; s < Scenarios; s++ {
			lc.Load[s] += ord.Demand
		}
	}
	cert.Cost = p.Costs(a)
	cert.Objective = Objective(cert.Cost)
	cert.Violations = p.Check(a)
	cert.Feasible = len(cert.Violations) == 0
	return cert
}
