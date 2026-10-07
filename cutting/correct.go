package cutting

import "sort"

// RemainingDemand computes newDemand minus already-cut pieces (which cannot
// be rolled back). It returns the remaining demand to plan for and any
// surplus pieces that were cut but are no longer required.
func RemainingDemand(newDemands []Demand, cut []PlacedPiece) (remaining, surplus []Demand) {
	need := map[int]int{}
	for _, d := range newDemands {
		need[d.Length] += d.Count
	}
	for _, c := range cut {
		need[c.Length]--
	}
	lengths := make([]int, 0, len(need))
	for l := range need {
		lengths = append(lengths, l)
	}
	sort.Ints(lengths)
	for _, l := range lengths {
		switch {
		case need[l] > 0:
			remaining = append(remaining, Demand{Length: l, Count: need[l]})
		case need[l] < 0:
			surplus = append(surplus, Demand{Length: l, Count: -need[l]})
		}
	}
	return remaining, surplus
}
