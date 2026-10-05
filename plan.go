package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"strings"
)

// maxPeriods bounds the planning horizon as required (at most 12 periods).
const maxPeriods = 12

// inf is a sentinel cost larger than any reachable total.
const inf = int64(1) << 60

// Period describes one planning slot. Demand, Price and the charge/discharge
// limits are integers; energy amounts are measured in grid units.
type Period struct {
	Demand         int `json:"demand"`
	Price          int `json:"price"`
	ChargeLimit    int `json:"chargeLimit"`
	DischargeLimit int `json:"dischargeLimit"`
}

// Spec is the full planning problem. State of charge lives on integer grid
// points in [0, Capacity]; Initial and Final fix the boundary conditions.
type Spec struct {
	Capacity     int      `json:"capacity"`
	Initial      int      `json:"initial"`
	Final        int      `json:"final"`
	ChargeEff    string   `json:"chargeEff"`
	DischargeEff string   `json:"dischargeEff"`
	Periods      []Period `json:"periods"`
}

// DecodeSpec reads and validates a JSON problem specification.
func DecodeSpec(r io.Reader) (Spec, error) {
	var s Spec
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&s); err != nil {
		return Spec{}, fmt.Errorf("decode spec: %w", err)
	}
	if err := s.validate(); err != nil {
		return Spec{}, err
	}
	return s, nil
}

func (s Spec) validate() error {
	if s.Capacity <= 0 {
		return fmt.Errorf("capacity must be positive, got %d", s.Capacity)
	}
	if s.Initial < 0 || s.Initial > s.Capacity {
		return fmt.Errorf("initial SOC %d outside [0, %d]", s.Initial, s.Capacity)
	}
	if s.Final < 0 || s.Final > s.Capacity {
		return fmt.Errorf("final SOC %d outside [0, %d]", s.Final, s.Capacity)
	}
	if len(s.Periods) == 0 {
		return fmt.Errorf("at least one period is required")
	}
	if len(s.Periods) > maxPeriods {
		return fmt.Errorf("at most %d periods allowed, got %d", maxPeriods, len(s.Periods))
	}
	if _, err := parseEff(s.ChargeEff); err != nil {
		return fmt.Errorf("chargeEff: %w", err)
	}
	if _, err := parseEff(s.DischargeEff); err != nil {
		return fmt.Errorf("dischargeEff: %w", err)
	}
	for i, p := range s.Periods {
		if p.Demand < 0 {
			return fmt.Errorf("period %d: negative demand %d", i+1, p.Demand)
		}
		if p.ChargeLimit < 0 {
			return fmt.Errorf("period %d: negative charge limit %d", i+1, p.ChargeLimit)
		}
		if p.DischargeLimit < 0 {
			return fmt.Errorf("period %d: negative discharge limit %d", i+1, p.DischargeLimit)
		}
	}
	return nil
}

// eff is a positive rational efficiency num/den in lowest terms.
type eff struct{ num, den int64 }

// parseEff parses a rational efficiency such as "0.95", "19/20" or "1".
func parseEff(s string) (eff, error) {
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		return eff{}, fmt.Errorf("invalid rational %q", s)
	}
	if r.Sign() <= 0 {
		return eff{}, fmt.Errorf("efficiency must be positive, got %q", s)
	}
	return eff{r.Num().Int64(), r.Denom().Int64()}, nil
}

// chargeStored maps grid energy g drawn while charging to stored energy
// g*num/den. It reports ok=false when the result is off the integer grid.
func (e eff) chargeStored(g int) (stored int, ok bool) {
	v := int64(g) * e.num
	if v%e.den != 0 {
		return 0, false
	}
	return int(v / e.den), true
}

// dischargeStored maps grid energy h delivered while discharging to stored
// energy h*den/num consumed. It reports ok=false off the integer grid.
func (e eff) dischargeStored(h int) (stored int, ok bool) {
	v := int64(h) * e.den
	if v%e.num != 0 {
		return 0, false
	}
	return int(v / e.num), true
}

// action is a per-period decision in grid-side energy units. Charge and
// discharge are mutually exclusive: at most one of them is non-zero.
type action struct {
	charge    int
	discharge int
}

// actionsFor enumerates every legal action of a period: idle, every on-grid
// charge amount up to the charge limit, and every on-grid discharge amount up
// to the discharge limit. Charging and discharging never mix in one action.
func actionsFor(p Period, ce, de eff) []action {
	acts := []action{{}}
	for g := 1; g <= p.ChargeLimit; g++ {
		if _, ok := ce.chargeStored(g); ok {
			acts = append(acts, action{charge: g})
		}
	}
	for h := 1; h <= p.DischargeLimit; h++ {
		if _, ok := de.dischargeStored(h); ok {
			acts = append(acts, action{discharge: h})
		}
	}
	return acts
}

// transition applies an action at a given SOC, returning the next SOC and the
// period cost price*(demand+charge-discharge). ok=false when the SOC would
// leave [0, capacity] or when the net grid purchase would go negative
// (discharging beyond demand, i.e. selling, is not part of the model).
func transition(soc int, a action, p Period, ce, de eff, capacity int) (next int, cost int64, ok bool) {
	cs, _ := ce.chargeStored(a.charge)
	ds, _ := de.dischargeStored(a.discharge)
	next = soc + cs - ds
	if next < 0 || next > capacity {
		return 0, 0, false
	}
	net := p.Demand + a.charge - a.discharge
	if net < 0 {
		return 0, 0, false
	}
	return next, int64(p.Price) * int64(net), true
}

// Step is one line of the energy certificate.
type Step struct {
	Period    int
	SOCBefore int
	SOCAfter  int
	Charge    int // grid energy drawn to charge
	Discharge int // grid energy delivered from discharge
	NetGrid   int // demand + charge - discharge
	Cost      int64
}

// Plan is the optimal schedule plus its total cost.
type Plan struct {
	Steps     []Step
	TotalCost int64
}

// Solve finds the minimum-cost schedule by dynamic programming over the
// integer SOC grid. It returns an error when the final SOC is unreachable.
func Solve(s Spec) (Plan, error) {
	if err := s.validate(); err != nil {
		return Plan{}, err
	}
	ce, _ := parseEff(s.ChargeEff)
	de, _ := parseEff(s.DischargeEff)
	n := len(s.Periods)

	prev := make([]int64, s.Capacity+1)
	for i := range prev {
		prev[i] = inf
	}
	prev[s.Initial] = 0

	type parent struct {
		soc int
		act action
	}
	parents := make([][]parent, n)
	for t, p := range s.Periods {
		cur := make([]int64, s.Capacity+1)
		par := make([]parent, s.Capacity+1)
		for i := range cur {
			cur[i] = inf
			par[i].soc = -1
		}
		for soc := 0; soc <= s.Capacity; soc++ {
			if prev[soc] >= inf {
				continue
			}
			for _, a := range actionsFor(p, ce, de) {
				next, cost, ok := transition(soc, a, p, ce, de, s.Capacity)
				if !ok {
					continue
				}
				if c := prev[soc] + cost; c < cur[next] {
					cur[next] = c
					par[next] = parent{soc: soc, act: a}
				}
			}
		}
		prev = cur
		parents[t] = par
	}
	if prev[s.Final] >= inf {
		return Plan{}, fmt.Errorf("infeasible: final SOC %d is unreachable", s.Final)
	}

	plan := Plan{Steps: make([]Step, n), TotalCost: prev[s.Final]}
	soc := s.Final
	for t := n - 1; t >= 0; t-- {
		par := parents[t][soc]
		p := s.Periods[t]
		plan.Steps[t] = Step{
			Period:    t + 1,
			SOCBefore: par.soc,
			SOCAfter:  soc,
			Charge:    par.act.charge,
			Discharge: par.act.discharge,
			NetGrid:   p.Demand + par.act.charge - par.act.discharge,
			Cost:      int64(p.Price) * int64(p.Demand+par.act.charge-par.act.discharge),
		}
		soc = par.soc
	}
	return plan, nil
}

// BruteForce enumerates every action sequence exhaustively and returns the
// minimum cost. It is the small-scale correctness oracle for Solve.
func BruteForce(s Spec) (best int64, feasible bool, err error) {
	if err := s.validate(); err != nil {
		return 0, false, err
	}
	ce, _ := parseEff(s.ChargeEff)
	de, _ := parseEff(s.DischargeEff)
	acts := make([][]action, len(s.Periods))
	for i, p := range s.Periods {
		acts[i] = actionsFor(p, ce, de)
	}
	best = inf
	var rec func(t, soc int, cost int64)
	rec = func(t, soc int, cost int64) {
		if t == len(s.Periods) {
			if soc == s.Final && cost < best {
				best = cost
			}
			return
		}
		for _, a := range acts[t] {
			next, c, ok := transition(soc, a, s.Periods[t], ce, de, s.Capacity)
			if !ok {
				continue
			}
			rec(t+1, next, cost+c)
		}
	}
	rec(0, s.Initial, 0)
	if best >= inf {
		return 0, false, nil
	}
	return best, true, nil
}

// RenderCertificate formats the per-period energy certificate as a table.
func RenderCertificate(pl Plan, s Spec) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%-6s %6s %6s %-9s %6s %9s %6s %9s %8s\n",
		"period", "demand", "price", "action", "charge", "discharge", "net", "soc", "cost")
	for i, st := range pl.Steps {
		name := "idle"
		switch {
		case st.Charge > 0:
			name = "charge"
		case st.Discharge > 0:
			name = "discharge"
		}
		fmt.Fprintf(&b, "%-6d %6d %6d %-9s %6d %9d %6d %4d->%-4d %8d\n",
			st.Period, s.Periods[i].Demand, s.Periods[i].Price, name,
			st.Charge, st.Discharge, st.NetGrid, st.SOCBefore, st.SOCAfter, st.Cost)
	}
	fmt.Fprintf(&b, "total cost: %d\n", pl.TotalCost)
	return b.String()
}
