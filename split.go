package formal

import (
	"fmt"
	"math"
	"math/big"
	"sort"
)

type weightedEntity struct {
	entity string
	weight int64
}

// splitWeighted divides amount exactly according to integer weights using the
// largest-remainder method. Ties are resolved by entity ID, so the result is
// deterministic and independent of input ordering. The returned amounts sum
// exactly to amount.
func splitWeighted(amount Money, entries []weightedEntity) ([]int64, error) {
	if len(entries) == 0 {
		return nil, fmt.Errorf("formal: no weighted recipients")
	}
	if amount == Money(math.MinInt64) {
		return nil, fmt.Errorf("formal: amount is too small to split")
	}

	totalWeight := int64(0)
	for _, entry := range entries {
		if entry.weight < 0 {
			return nil, fmt.Errorf("formal: negative weight for entity %q", entry.entity)
		}
		if entry.weight > math.MaxInt64-totalWeight {
			return nil, fmt.Errorf("formal: weight total overflow")
		}
		totalWeight += entry.weight
	}
	if totalWeight == 0 {
		return nil, fmt.Errorf("formal: total weight must be positive")
	}

	negative := amount < 0
	absolute := new(big.Int).SetInt64(int64(amount))
	absolute.Abs(absolute)
	total := big.NewInt(totalWeight)

	quotients := make([]big.Int, len(entries))
	remainders := make([]big.Int, len(entries))
	sum := new(big.Int)
	for i, entry := range entries {
		numerator := new(big.Int).Mul(absolute, big.NewInt(entry.weight))
		quotients[i].QuoRem(numerator, total, &remainders[i])
		sum.Add(sum, &quotients[i])
	}

	remaining := new(big.Int).Sub(absolute, sum)
	if !remaining.IsInt64() {
		return nil, fmt.Errorf("formal: split remainder overflow")
	}
	remainingCount := remaining.Int64()
	if remainingCount < 0 || remainingCount > int64(len(entries)-1) {
		return nil, fmt.Errorf("formal: invalid split remainder %d", remainingCount)
	}

	order := make([]int, len(entries))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(i, j int) bool {
		left := &remainders[order[i]]
		right := &remainders[order[j]]
		if cmp := left.Cmp(right); cmp != 0 {
			return cmp > 0
		}
		return entries[order[i]].entity < entries[order[j]].entity
	})
	for i := int64(0); i < remainingCount; i++ {
		quotients[order[i]].Add(&quotients[order[i]], big.NewInt(1))
	}

	allocations := make([]int64, len(entries))
	limit := new(big.Int).SetUint64(math.MaxInt64)
	if negative {
		limit.Add(limit, big.NewInt(1))
	}
	for i := range quotients {
		if quotients[i].Cmp(limit) > 0 {
			return nil, fmt.Errorf("formal: allocated amount out of range")
		}
		value := quotients[i].Int64()
		if negative {
			value = -value
		}
		allocations[i] = value
	}
	return allocations, nil
}
