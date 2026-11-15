package dataeng

import (
	"fmt"
	"math"
)

// BuildTarget constructs an independent split/class target matrix:
// target[s][c] = splitShare[s] * classShare[c]. Both input maps are
// normalized independently. The result is convenient for the common case where
// each split should reproduce the corpus class distribution.
func BuildTarget(splitShares map[SplitName]float64, classShares map[string]float64) (Target, error) {
	splits, err := normalizedSplitShares(splitShares)
	if err != nil {
		return nil, err
	}
	classes, err := normalizeClassShareMap(classShares)
	if err != nil {
		return nil, err
	}
	target := make(Target, len(splits))
	for split, splitShare := range splits {
		target[split] = make(map[string]float64, len(classes))
		for class, classShare := range classes {
			target[split][class] = splitShare * classShare
		}
	}
	return target, nil
}

func normalizeClassShareMap(shares map[string]float64) (map[string]float64, error) {
	if len(shares) == 0 {
		return nil, fmt.Errorf("%w: class shares are empty", ErrInvalidInput)
	}
	out := make(map[string]float64, len(shares))
	var sum float64
	for _, class := range sortedKeys(shares) {
		value := shares[class]
		if value < 0 || math.IsNaN(value) || math.IsInf(value, 0) {
			return nil, fmt.Errorf("%w: invalid class share for %q: %v", ErrInvalidInput, class, value)
		}
		out[class] += value
		sum += value
	}
	if sum <= 0 {
		return nil, fmt.Errorf("%w: class shares have no positive mass", ErrInvalidInput)
	}
	for class, value := range out {
		out[class] = value / sum
	}
	return out, nil
}
