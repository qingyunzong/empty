package main

import (
	"fmt"
	"math/big"
)

// MaxSlots is the planning horizon limit.
const MaxSlots = 12

// Rat is a rational number num/den, used for efficiencies so that all
// energy and cost arithmetic stays exact.
type Rat struct {
	Num int64 `json:"num"`
	Den int64 `json:"den"`
}

func (r Rat) big() *big.Rat {
	return big.NewRat(r.Num, r.Den)
}

// Slot describes one planning period. All energies are integers on the
// grid-point lattice (one unit = one grid point).
type Slot struct {
	Demand         int `json:"demand"`          // load that must be served
	Price          int `json:"price"`           // price per grid-energy unit
	ChargeLimit    int `json:"charge_limit"`    // max battery-energy charged this slot
	DischargeLimit int `json:"discharge_limit"` // max battery-energy discharged this slot
}

// Instance is a full scheduling problem.
type Instance struct {
	Capacity     int    `json:"capacity"`      // battery capacity in grid points
	InitialSOC   int    `json:"initial_soc"`   // state of charge at slot 0
	FinalSOCMin  int    `json:"final_soc_min"` // minimum required SOC after the last slot
	ChargeEff    Rat    `json:"charge_efficiency"`
	DischargeEff Rat    `json:"discharge_efficiency"`
	Slots        []Slot `json:"slots"`
}

func (inst *Instance) validate() error {
	if inst.Capacity <= 0 {
		return fmt.Errorf("capacity must be positive, got %d", inst.Capacity)
	}
	if inst.InitialSOC < 0 || inst.InitialSOC > inst.Capacity {
		return fmt.Errorf("initial_soc %d outside [0, %d]", inst.InitialSOC, inst.Capacity)
	}
	if inst.FinalSOCMin < 0 || inst.FinalSOCMin > inst.Capacity {
		return fmt.Errorf("final_soc_min %d outside [0, %d]", inst.FinalSOCMin, inst.Capacity)
	}
	if inst.ChargeEff.Num <= 0 || inst.ChargeEff.Den <= 0 {
		return fmt.Errorf("charge efficiency must be a positive rational")
	}
	if inst.DischargeEff.Num <= 0 || inst.DischargeEff.Den <= 0 {
		return fmt.Errorf("discharge efficiency must be a positive rational")
	}
	if len(inst.Slots) == 0 {
		return fmt.Errorf("need at least one slot")
	}
	if len(inst.Slots) > MaxSlots {
		return fmt.Errorf("at most %d slots, got %d", MaxSlots, len(inst.Slots))
	}
	for i, s := range inst.Slots {
		if s.Demand < 0 || s.ChargeLimit < 0 || s.DischargeLimit < 0 {
			return fmt.Errorf("slot %d: demand and limits must be non-negative", i+1)
		}
	}
	return nil
}

// Action is what the battery does in one slot. Charge and Discharge are
// never both positive (no simultaneous charge/discharge).
type Action struct {
	Charge    int
	Discharge int
}

// actions lists every feasible action for a slot given the current SOC.
// Charge/discharge amounts are battery-energy units on the integer lattice.
func actions(s Slot, soc, capacity int) []Action {
	acts := make([]Action, 0, 1+s.ChargeLimit+s.DischargeLimit)
	acts = append(acts, Action{}) // idle
	maxCharge := s.ChargeLimit
	if rem := capacity - soc; rem < maxCharge {
		maxCharge = rem
	}
	for c := 1; c <= maxCharge; c++ {
		acts = append(acts, Action{Charge: c})
	}
	maxDischarge := s.DischargeLimit
	if soc < maxDischarge {
		maxDischarge = soc
	}
	for d := 1; d <= maxDischarge; d++ {
		acts = append(acts, Action{Discharge: d})
	}
	return acts
}

// gridEnergy returns the exact net grid energy bought in a slot:
// demand + charge/etaC - discharge*etaD. Negative means selling back.
func gridEnergy(inst *Instance, s Slot, a Action) *big.Rat {
	g := big.NewRat(int64(s.Demand), 1)
	if a.Charge > 0 {
		// grid in = battery energy / etaC
		q := new(big.Rat).SetInt64(int64(a.Charge))
		q.Quo(q, inst.ChargeEff.big())
		g.Add(g, q)
	}
	if a.Discharge > 0 {
		// grid offset = battery energy * etaD
		q := new(big.Rat).SetInt64(int64(a.Discharge))
		q.Mul(q, inst.DischargeEff.big())
		g.Sub(g, q)
	}
	return g
}

// slotCost is price * gridEnergy, exact.
func slotCost(inst *Instance, s Slot, a Action) *big.Rat {
	c := gridEnergy(inst, s, a)
	return c.Mul(c, big.NewRat(int64(s.Price), 1))
}
