package main

import (
	"fmt"
	"math/big"
)

// BruteForce enumerates every feasible action sequence and returns the
// exact minimum total cost. Exponential; intended for small instances
// where it serves as ground truth for the DP solver.
func BruteForce(inst *Instance) (*big.Rat, error) {
	if err := inst.validate(); err != nil {
		return nil, err
	}
	var best *big.Rat
	var rec func(t, soc int, acc *big.Rat)
	rec = func(t, soc int, acc *big.Rat) {
		if t == len(inst.Slots) {
			if soc >= inst.FinalSOCMin && (best == nil || acc.Cmp(best) < 0) {
				best = new(big.Rat).Set(acc)
			}
			return
		}
		for _, a := range actions(inst.Slots[t], soc, inst.Capacity) {
			cost := new(big.Rat).Add(acc, slotCost(inst, inst.Slots[t], a))
			rec(t+1, soc+a.Charge-a.Discharge, cost)
		}
	}
	rec(0, inst.InitialSOC, big.NewRat(0, 1))
	if best == nil {
		return nil, fmt.Errorf("infeasible: final_soc_min %d is unreachable", inst.FinalSOCMin)
	}
	return best, nil
}
