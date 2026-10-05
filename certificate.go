package contractopt

import "fmt"

// ResourcePeriod identifies one (period, resource) capacity slot.
type ResourcePeriod struct {
	Period   int
	Resource int
}

// Certificate is a dependency certificate for a solution: it records every
// constraint the optimal assignment depends on, so an auditor can re-check
// feasibility and see exactly which capacities, prerequisites, mutex groups
// and count limits are binding.
type Certificate struct {
	Revenue      int64            // objective revenue of the certified solution
	Usage        int64            // objective total resource usage
	Selected     []string         // selected contract IDs (input order)
	UsedPrereqs  [][2]string      // realized edges {prereq, dependent}
	FullGroups   []string         // mutex groups holding one selected contract
	Saturated    []ResourcePeriod // slots where usage equals capacity
	CountBinding bool             // true when the selection limit is reached
	SearchNodes  int              // branch-and-bound nodes explored
}

// buildCertificate derives the certificate from a solved instance.
func buildCertificate(in *Instance, sol Solution, nodes int) *Certificate {
	cert := &Certificate{
		Revenue:      sol.Revenue,
		Usage:        sol.Usage,
		CountBinding: len(sol.Assign) == in.MaxSelect,
		SearchNodes:  nodes,
	}
	used := make([][]int64, in.Periods)
	for p := range used {
		used[p] = make([]int64, in.Resources)
	}
	for i := range in.Contracts {
		c := &in.Contracts[i]
		st, sel := sol.Assign[c.ID]
		if !sel {
			continue
		}
		cert.Selected = append(cert.Selected, c.ID)
		if c.Group != "" {
			cert.FullGroups = append(cert.FullGroups, c.Group)
		}
		for _, qid := range c.Prereqs {
			if _, ok := sol.Assign[qid]; ok {
				cert.UsedPrereqs = append(cert.UsedPrereqs, [2]string{qid, c.ID})
			}
		}
		for p := st; p < st+c.Duration; p++ {
			for r := 0; r < in.Resources; r++ {
				used[p][r] += c.Demand[r]
			}
		}
	}
	for p := 0; p < in.Periods; p++ {
		for r := 0; r < in.Resources; r++ {
			if used[p][r] == in.Capacity[p][r] && in.Capacity[p][r] > 0 {
				cert.Saturated = append(cert.Saturated, ResourcePeriod{Period: p, Resource: r})
			}
		}
	}
	return cert
}

// Verify re-checks the certificate against the instance and solution: the
// assignment must be feasible, its objective values must match, and every
// recorded dependency must be real. It does not by itself prove optimality;
// pair it with VerifyOptimalByEnumeration on small instances.
func (cert *Certificate) Verify(in *Instance, sol Solution) error {
	if _, err := in.Evaluate(sol.Assign); err != nil {
		return err
	}
	if sol.Revenue != cert.Revenue || sol.Usage != cert.Usage {
		return fmt.Errorf("contractopt: certificate objective (%d,%d) != solution (%d,%d)",
			cert.Revenue, cert.Usage, sol.Revenue, sol.Usage)
	}
	want := buildCertificate(in, sol, cert.SearchNodes)
	if !equalStrings(cert.Selected, want.Selected) {
		return fmt.Errorf("contractopt: certificate Selected mismatch")
	}
	if !equalPairs(cert.UsedPrereqs, want.UsedPrereqs) {
		return fmt.Errorf("contractopt: certificate UsedPrereqs mismatch")
	}
	if !equalStrings(cert.FullGroups, want.FullGroups) {
		return fmt.Errorf("contractopt: certificate FullGroups mismatch")
	}
	if !equalSlots(cert.Saturated, want.Saturated) {
		return fmt.Errorf("contractopt: certificate Saturated mismatch")
	}
	if cert.CountBinding != want.CountBinding {
		return fmt.Errorf("contractopt: certificate CountBinding mismatch")
	}
	return nil
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func equalPairs(a, b [][2]string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func equalSlots(a, b []ResourcePeriod) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// SaturatedSlot reports whether the certificate marks (period, resource) as
// saturated.
func (cert *Certificate) SaturatedSlot(period, resource int) bool {
	for _, s := range cert.Saturated {
		if s.Period == period && s.Resource == resource {
			return true
		}
	}
	return false
}
