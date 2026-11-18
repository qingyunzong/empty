package formal

import (
	"math"
	"sort"
)

// apportionItem is one claimant in an integer apportionment round. demand is
// the claim used for proportional weighting, max is the hard upper bound on
// this claimant's grant, priority is used as a deterministic tie-break, and
// order is the final stable tie-break (normally a node id or creation
// sequence).
type apportionItem struct {
	demand   int64
	max      int64
	priority int64
	order    string
}

// apportion divides capacity among items in proportion to demand. Every grant
// is an integer, no grant exceeds max, and the sum of grants is
// min(capacity, sum(max)). Leftover units use the largest-remainder method,
// with ties broken by higher priority and then by the stable order string.
func apportion(capacity int64, items []apportionItem) []int64 {
	grants := make([]int64, len(items))
	if capacity <= 0 || len(items) == 0 {
		return grants
	}

	active := make([]bool, len(items))
	var anyActive bool
	for i := range items {
		if items[i].max > 0 && items[i].demand > 0 {
			active[i] = true
			anyActive = true
		}
	}
	if !anyActive {
		return grants
	}

	remaining := capacity
	for remaining > 0 {
		var sumMax int64
		var sumDemand int64
		sumMaxOverflow := false
		any := false
		for i := range items {
			if !active[i] {
				continue
			}
			maxAdd := items[i].max - grants[i]
			if maxAdd <= 0 {
				active[i] = false
				continue
			}
			demandLeft := items[i].demand - grants[i]
			if demandLeft <= 0 {
				active[i] = false
				continue
			}
			if _, ok := safeAdd(sumMax, maxAdd); !ok {
				sumMax = math.MaxInt64
				sumMaxOverflow = true
			} else {
				sumMax += maxAdd
			}
			if _, ok := safeAdd(sumDemand, demandLeft); !ok {
				sumDemand = math.MaxInt64
			} else {
				sumDemand += demandLeft
			}
			any = true
		}
		if !any || sumDemand == 0 {
			break
		}

		// Everyone can take the rest of their claim.
		if !sumMaxOverflow && sumMax <= remaining {
			for i := range items {
				if active[i] {
					grants[i] += items[i].max - grants[i]
				}
			}
			break
		}

		type residual struct {
			index     int
			remainder int64
		}
		residuals := make([]residual, 0, len(items))
		added := int64(0)
		clamped := false
		for i := range items {
			if !active[i] {
				continue
			}
			maxAdd := items[i].max - grants[i]
			demandLeft := items[i].demand - grants[i]
			share, remainder := mulDiv(remaining, demandLeft, sumDemand)
			if share >= maxAdd {
				share = maxAdd
				clamped = true
				active[i] = false
			} else {
				residuals = append(residuals, residual{index: i, remainder: remainder})
			}
			grants[i] += share
			added += share
		}
		remaining -= added

		if clamped {
			// Clamped claimants were removed from the active set. Recompute the
			// proportional split for the remainder of the capacity.
			continue
		}

		sort.SliceStable(residuals, func(i, j int) bool {
			if residuals[i].remainder != residuals[j].remainder {
				return residuals[i].remainder > residuals[j].remainder
			}
			left := items[residuals[i].index]
			right := items[residuals[j].index]
			if left.priority != right.priority {
				return left.priority > right.priority
			}
			return left.order < right.order
		})
		for _, r := range residuals {
			if remaining == 0 {
				break
			}
			if grants[r.index] < items[r.index].max {
				grants[r.index]++
				remaining--
			}
		}
		break
	}
	return grants
}
