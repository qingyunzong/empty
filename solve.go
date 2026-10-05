package main

import (
	"fmt"
	"math/big"
)

// Step is one slot's entry in the energy certificate.
type Step struct {
	Slot       int    `json:"slot"`
	Action     string `json:"action"` // "idle" | "charge" | "discharge"
	Charge     int    `json:"charge"`
	Discharge  int    `json:"discharge"`
	SOCAfter   int    `json:"soc_after"`
	GridEnergy string `json:"grid_energy"` // exact rational, negative = sold back
	Cost       string `json:"cost"`        // exact rational
}

// Certificate is the full per-slot plan plus its exact total cost.
type Certificate struct {
	TotalCost string `json:"total_cost"`
	FinalSOC  int    `json:"final_soc"`
	Steps     []Step `json:"steps"`
}

// TotalCostRat parses the certificate's total cost back into a rational.
func (c *Certificate) TotalCostRat() (*big.Rat, error) {
	r, ok := new(big.Rat).SetString(c.TotalCost)
	if !ok {
		return nil, fmt.Errorf("bad total_cost %q", c.TotalCost)
	}
	return r, nil
}

// Solve finds a minimum-cost schedule by dynamic programming over the
// integer SOC lattice. Costs are exact rationals.
func Solve(inst *Instance) (*Certificate, error) {
	if err := inst.validate(); err != nil {
		return nil, err
	}
	n := len(inst.Slots)
	cap := inst.Capacity

	type parent struct {
		prevSOC   int
		charge    int
		discharge int
	}

	prev := make([]*big.Rat, cap+1) // nil = unreachable
	prev[inst.InitialSOC] = big.NewRat(0, 1)
	parents := make([][]parent, n)

	for t := 0; t < n; t++ {
		next := make([]*big.Rat, cap+1)
		par := make([]parent, cap+1)
		for soc := 0; soc <= cap; soc++ {
			if prev[soc] == nil {
				continue
			}
			for _, a := range actions(inst.Slots[t], soc, cap) {
				ns := soc + a.Charge - a.Discharge
				cost := new(big.Rat).Add(prev[soc], slotCost(inst, inst.Slots[t], a))
				if next[ns] == nil || cost.Cmp(next[ns]) < 0 {
					next[ns] = cost
					par[ns] = parent{prevSOC: soc, charge: a.Charge, discharge: a.Discharge}
				}
			}
		}
		prev = next
		parents[t] = par
	}

	bestSOC := -1
	for soc := inst.FinalSOCMin; soc <= cap; soc++ {
		if prev[soc] == nil {
			continue
		}
		if bestSOC == -1 || prev[soc].Cmp(prev[bestSOC]) < 0 {
			bestSOC = soc
		}
	}
	if bestSOC == -1 {
		return nil, fmt.Errorf("infeasible: final_soc_min %d is unreachable", inst.FinalSOCMin)
	}

	// Reconstruct actions backwards.
	acts := make([]Action, n)
	soc := bestSOC
	for t := n - 1; t >= 0; t-- {
		p := parents[t][soc]
		acts[t] = Action{Charge: p.charge, Discharge: p.discharge}
		soc = p.prevSOC
	}

	cert := &Certificate{FinalSOC: bestSOC, Steps: make([]Step, n)}
	total := big.NewRat(0, 1)
	soc = inst.InitialSOC
	for t := 0; t < n; t++ {
		a := acts[t]
		soc += a.Charge - a.Discharge
		g := gridEnergy(inst, inst.Slots[t], a)
		c := new(big.Rat).Mul(g, big.NewRat(int64(inst.Slots[t].Price), 1))
		total.Add(total, c)
		name := "idle"
		if a.Charge > 0 {
			name = "charge"
		} else if a.Discharge > 0 {
			name = "discharge"
		}
		cert.Steps[t] = Step{
			Slot:       t + 1,
			Action:     name,
			Charge:     a.Charge,
			Discharge:  a.Discharge,
			SOCAfter:   soc,
			GridEnergy: g.RatString(),
			Cost:       c.RatString(),
		}
	}
	cert.TotalCost = total.RatString()
	return cert, nil
}

// Verify replays a certificate against the instance and checks every
// physical constraint plus the claimed total cost.
func Verify(inst *Instance, cert *Certificate) error {
	if err := inst.validate(); err != nil {
		return err
	}
	if len(cert.Steps) != len(inst.Slots) {
		return fmt.Errorf("certificate has %d steps, instance has %d slots", len(cert.Steps), len(inst.Slots))
	}
	soc := inst.InitialSOC
	total := big.NewRat(0, 1)
	for t, st := range cert.Steps {
		s := inst.Slots[t]
		if st.Charge > 0 && st.Discharge > 0 {
			return fmt.Errorf("slot %d: simultaneous charge and discharge", t+1)
		}
		if st.Charge > s.ChargeLimit {
			return fmt.Errorf("slot %d: charge %d exceeds limit %d", t+1, st.Charge, s.ChargeLimit)
		}
		if st.Discharge > s.DischargeLimit {
			return fmt.Errorf("slot %d: discharge %d exceeds limit %d", t+1, st.Discharge, s.DischargeLimit)
		}
		soc += st.Charge - st.Discharge
		if soc < 0 || soc > inst.Capacity {
			return fmt.Errorf("slot %d: SOC %d outside [0, %d]", t+1, soc, inst.Capacity)
		}
		if st.SOCAfter != soc {
			return fmt.Errorf("slot %d: recorded SOC %d, recomputed %d", t+1, st.SOCAfter, soc)
		}
		a := Action{Charge: st.Charge, Discharge: st.Discharge}
		g := gridEnergy(inst, s, a)
		if g.RatString() != st.GridEnergy {
			return fmt.Errorf("slot %d: recorded grid energy %s, recomputed %s", t+1, st.GridEnergy, g.RatString())
		}
		c := new(big.Rat).Mul(g, big.NewRat(int64(s.Price), 1))
		if c.RatString() != st.Cost {
			return fmt.Errorf("slot %d: recorded cost %s, recomputed %s", t+1, st.Cost, c.RatString())
		}
		total.Add(total, c)
	}
	if soc < inst.FinalSOCMin {
		return fmt.Errorf("final SOC %d below required minimum %d", soc, inst.FinalSOCMin)
	}
	if soc != cert.FinalSOC {
		return fmt.Errorf("recorded final SOC %d, recomputed %d", cert.FinalSOC, soc)
	}
	if total.RatString() != cert.TotalCost {
		return fmt.Errorf("recorded total cost %s, recomputed %s", cert.TotalCost, total.RatString())
	}
	return nil
}
