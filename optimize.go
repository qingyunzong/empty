package dataeng

import "math"

const (
	maxExhaustiveKeys                     = 64
	exhaustiveCombinationLimit            = 1_000_000
	maxForcedExhaustiveCombinations int64 = 10_000_000
)

// chooseEnds returns the exclusive end index of every non-empty range. The
// final end is len(weights). For a request with more partitions than keys,
// chooseEnds returns one singleton range per key and the caller appends the
// empty trailing ranges.
func chooseEnds(weights []float64, partitions int, forceExhaustive bool) []int {
	keyCount := len(weights)
	if keyCount == 0 {
		return nil
	}
	if partitions >= keyCount {
		ends := make([]int, keyCount)
		for i := range ends {
			ends[i] = i + 1
		}
		return ends
	}
	if partitions == 1 {
		return []int{keyCount}
	}

	if forceExhaustive ||
		(keyCount <= maxExhaustiveKeys &&
			combinationsAtMost(keyCount-1, partitions-1, exhaustiveCombinationLimit)) {
		return exhaustiveEnds(weights, partitions)
	}
	return binarySearchEnds(weights, partitions)
}

func combinationsAtMost(n, k int, limit int64) bool {
	if k < 0 || k > n {
		return false
	}
	if k == 0 || k == n {
		return true
	}
	if k > n-k {
		k = n - k
	}

	result := int64(1)
	for i := 1; i <= k; i++ {
		numerator := int64(n - k + i)
		denominator := int64(i)
		if result > (limit*denominator)/numerator {
			return false
		}
		result = result * numerator / denominator
		if result > limit {
			return false
		}
	}
	return true
}

// exhaustiveEnds enumerates all placements of the P-1 cuts. It is exact for
// small key domains and is also the reference used by the optimizer's tests.
// Iterating cut positions in ascending order makes the first plan found for a
// given maximum load the lexicographically smallest one.
func exhaustiveEnds(weights []float64, partitions int) []int {
	keyCount := len(weights)
	prefix := make([]float64, keyCount+1)
	for i, weight := range weights {
		prefix[i+1] = prefix[i] + weight
	}

	cuts := make([]int, partitions-1)
	bestCuts := make([]int, partitions-1)
	bestMax := math.Inf(1)
	found := false

	var search func(group, start int, currentMax float64)
	search = func(group, start int, currentMax float64) {
		if group == partitions-1 {
			lastLoad := prefix[keyCount] - prefix[start]
			candidateMax := currentMax
			if lastLoad > candidateMax {
				candidateMax = lastLoad
			}
			if !found || candidateMax < bestMax {
				found = true
				bestMax = candidateMax
				copy(bestCuts, cuts)
			}
			return
		}

		// Leave one key for each range that has not been started yet.
		maxEnd := keyCount - (partitions - 1 - group)
		for end := start + 1; end <= maxEnd; end++ {
			load := prefix[end] - prefix[start]
			nextMax := currentMax
			if load > nextMax {
				nextMax = load
			}
			cuts[group] = end
			search(group+1, end, nextMax)
		}
	}

	search(0, 0, 0)
	return append(bestCuts, keyCount)
}

func binarySearchEnds(weights []float64, partitions int) []int {
	total := 0.0
	maxWeight := 0.0
	for _, weight := range weights {
		total += weight
		if weight > maxWeight {
			maxWeight = weight
		}
	}

	capacity := maxWeight
	if groupsNeeded(weights, capacity, partitions) > partitions {
		// A partition can never hold less than its heaviest key, and P ranges
		// must hold the total load, so total/P is also a lower bound.
		low := math.Max(maxWeight, total/float64(partitions))
		high := total
		for iteration := 0; iteration < 80; iteration++ {
			mid := low + (high-low)/2
			if mid == low || mid == high {
				break
			}
			if groupsNeeded(weights, mid, partitions) <= partitions {
				high = mid
			} else {
				low = mid
			}
		}
		capacity = high
	}

	if ends, ok := reconstructEnds(weights, partitions, capacity); ok {
		return ends
	}

	// This path is only a numerical safety net. A one-ulp increase normally
	// makes the capacity feasible immediately.
	for attempt := 0; attempt < 8; attempt++ {
		capacity = math.Nextafter(capacity, math.Inf(1))
		if ends, ok := reconstructEnds(weights, partitions, capacity); ok {
			return ends
		}
	}
	return greedyEnds(weights, partitions, capacity)
}

// groupsNeeded returns the minimum number of contiguous groups required when
// every group sum must be at most capacity. It stops as soon as the answer is
// known to exceed limit.
func groupsNeeded(weights []float64, capacity float64, limit int) int {
	groups := 1
	sum := 0.0
	for _, weight := range weights {
		if weight > capacity {
			return limit + 1
		}
		if sum+weight > capacity {
			groups++
			if groups > limit {
				return groups
			}
			sum = weight
		} else {
			sum += weight
		}
	}
	return groups
}

// reconstructEnds finds the lexicographically smallest boundary sequence that
// uses exactly partitions non-empty groups and keeps every group within
// capacity.
func reconstructEnds(weights []float64, partitions int, capacity float64) ([]int, bool) {
	keyCount := len(weights)
	next := make([]int, keyCount)
	suffixGroups := make([]int, keyCount+1)

	end := 0
	sum := 0.0
	for start := 0; start < keyCount; start++ {
		if end < start {
			end = start
			sum = 0
		}
		for end < keyCount && sum+weights[end] <= capacity {
			sum += weights[end]
			end++
		}
		if end == start {
			return nil, false
		}
		next[start] = end
		sum -= weights[start]
		if sum < 0 {
			sum = 0
		}
	}

	suffixGroups[keyCount] = 0
	for start := keyCount - 1; start >= 0; start-- {
		suffixGroups[start] = 1 + suffixGroups[next[start]]
	}

	cuts := make([]int, 0, partitions-1)
	start := 0
	for remaining := partitions; remaining > 1; remaining-- {
		maxEnd := keyCount - (remaining - 1)
		if maxEnd < start+1 {
			return nil, false
		}

		chosen := -1
		load := 0.0
		for end := start + 1; end <= maxEnd; end++ {
			load += weights[end-1]
			if load > capacity {
				break
			}
			if suffixGroups[end] <= remaining-1 {
				chosen = end
				break
			}
		}
		if chosen < 0 {
			return nil, false
		}
		cuts = append(cuts, chosen)
		start = chosen
	}
	return append(cuts, keyCount), true
}

func greedyEnds(weights []float64, partitions int, capacity float64) []int {
	keyCount := len(weights)
	ends := make([]int, 0, partitions)
	start := 0
	sum := 0.0
	for i, weight := range weights {
		if i > start && sum+weight > capacity {
			ends = append(ends, i)
			start = i
			sum = 0
		}
		sum += weight
	}
	ends = append(ends, keyCount)
	if len(ends) > partitions {
		return evenEnds(keyCount, partitions)
	}

	for len(ends) < partitions {
		previous := 0
		splitAt := -1
		for _, end := range ends {
			if end-previous >= 2 {
				splitAt = previous + 1
				break
			}
			previous = end
		}
		if splitAt < 0 {
			break
		}
		insertAt := 0
		for insertAt < len(ends) && ends[insertAt] < splitAt {
			insertAt++
		}
		ends = append(ends, 0)
		copy(ends[insertAt+1:], ends[insertAt:])
		ends[insertAt] = splitAt
	}
	return ends
}

// evenEnds is the last-resort partition used only if numerical trouble makes
// the capacity-based reconstruction unusable. It distributes whole keys as
// evenly as possible and always returns exactly partitions non-empty ranges.
func evenEnds(keyCount, partitions int) []int {
	ends := make([]int, partitions)
	base := keyCount / partitions
	extra := keyCount % partitions
	end := 0
	for i := range ends {
		size := base
		if i < extra {
			size++
		}
		end += size
		ends[i] = end
	}
	return ends
}
