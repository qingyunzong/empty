// Package reference provides a deliberately small, indexed expansion of the
// fixed-scale merge. It is intended as a readable cross-check for tests and
// examples, not as the collector's production path.
//
// The implementation allocates a dense index range and enumerates each old
// index inside its destination bucket. It does not use the map-based merge,
// span calculation, or threshold-closure helpers from the dataeng package.
package reference

import (
	"fmt"
	"math/big"

	"example.org/dataeng/q0304"
)

// MergeAtScale merges all histograms at exactly scale. Every input scale must
// be at least scale. Threshold closure follows the same exact-arithmetic
// rules as the main package, including strict crossing and upper==T
// absorption.
func MergeAtScale(hs []dataeng.Histogram, scale int) (dataeng.Histogram, error) {
	if scale < dataeng.MinScale || scale > dataeng.MaxScale {
		return dataeng.Histogram{}, fmt.Errorf("reference: scale %d out of range", scale)
	}
	if len(hs) == 0 {
		return dataeng.Histogram{
			Scale:     scale,
			Threshold: dataeng.NewZeroThreshold(),
		}, nil
	}
	for i := range hs {
		if err := dataeng.ValidateHistogram(hs[i]); err != nil {
			return dataeng.Histogram{}, fmt.Errorf("reference: histogram %d: %w", i, err)
		}
		if hs[i].Scale < scale {
			return dataeng.Histogram{}, fmt.Errorf(
				"reference: histogram %d cannot be upscaled from %d to %d",
				i, hs[i].Scale, scale)
		}
	}

	pos, posMin, err := mergeSide(hs, scale, func(h dataeng.Histogram) dataeng.Group {
		return h.Positive
	})
	if err != nil {
		return dataeng.Histogram{}, err
	}
	neg, negMin, err := mergeSide(hs, scale, func(h dataeng.Histogram) dataeng.Group {
		return h.Negative
	})
	if err != nil {
		return dataeng.Histogram{}, err
	}

	var zeroCount uint64
	var totalCount uint64
	var threshold = dataeng.NewZeroThreshold()
	for i := range hs {
		var ok bool
		if zeroCount, ok = add(zeroCount, hs[i].ZeroCount); !ok {
			return dataeng.Histogram{}, fmt.Errorf("reference: zero count overflow")
		}
		if totalCount, ok = add(totalCount, hs[i].Count); !ok {
			return dataeng.Histogram{}, fmt.Errorf("reference: total count overflow")
		}
		threshold = maxThreshold(threshold, hs[i].Threshold)
	}

	threshold, err = closeAtScale(scale, threshold, &zeroCount, pos, posMin, neg, negMin)
	if err != nil {
		return dataeng.Histogram{}, err
	}

	return dataeng.Histogram{
		Scale:     scale,
		Threshold: canonicalThreshold(threshold),
		Positive:  trimDense(pos, posMin),
		Negative:  trimDense(neg, negMin),
		ZeroCount: zeroCount,
		Count:     totalCount,
	}, nil
}

type groupSelector func(dataeng.Histogram) dataeng.Group

// mergeSide performs the unfolded merge for one side. It first finds the
// union of destination ranges, then walks every old index in each destination
// bucket.
func mergeSide(hs []dataeng.Histogram, scale int, selectGroup groupSelector) ([]uint64, int64, error) {
	type inputRange struct {
		group     dataeng.Group
		oldMin    int64
		oldMax    int64
		targetMin int64
		targetMax int64
		divisor   int64
	}

	var ranges []inputRange
	haveRange := false
	var unionMin, unionMax int64
	for i := range hs {
		g := selectGroup(hs[i])
		if len(g.Counts) == 0 {
			continue
		}
		d := hs[i].Scale - scale
		divisor := int64(1) << uint(d)
		oldMin := int64(g.Offset)
		oldMax := oldMin + int64(len(g.Counts)) - 1
		targetMin := floorDiv(oldMin, divisor)
		targetMax := floorDiv(oldMax, divisor)
		ranges = append(ranges, inputRange{
			group:     g,
			oldMin:    oldMin,
			oldMax:    oldMax,
			targetMin: targetMin,
			targetMax: targetMax,
			divisor:   divisor,
		})
		if !haveRange {
			unionMin, unionMax = targetMin, targetMax
			haveRange = true
		} else {
			if targetMin < unionMin {
				unionMin = targetMin
			}
			if targetMax > unionMax {
				unionMax = targetMax
			}
		}
	}

	if !haveRange {
		return nil, 0, nil
	}
	dense := make([]uint64, int(unionMax-unionMin+1))
	for _, r := range ranges {
		for target := r.targetMin; target <= r.targetMax; target++ {
			lo := target * r.divisor
			if lo < r.oldMin {
				lo = r.oldMin
			}
			hi := lo + r.divisor - 1
			// Clamp hi against both the target bucket and the source range.
			nextStart := (target + 1) * r.divisor
			if hi >= nextStart {
				hi = nextStart - 1
			}
			if hi > r.oldMax {
				hi = r.oldMax
			}
			for oldIndex := lo; oldIndex <= hi; oldIndex++ {
				count := r.group.Counts[int(oldIndex-r.oldMin)]
				if count == 0 {
					continue
				}
				var ok bool
				slot := int(target - unionMin)
				dense[slot], ok = add(dense[slot], count)
				if !ok {
					return nil, 0, fmt.Errorf("reference: count overflow while expanding")
				}
			}
		}
	}
	return dense, unionMin, nil
}

func closeAtScale(scale int, threshold dataeng.Threshold, zeroCount *uint64,
	positive []uint64, positiveMin int64,
	negative []uint64, negativeMin int64) (dataeng.Threshold, error) {
	if threshold.IsZero {
		return threshold, nil
	}

	type side struct {
		counts []uint64
		min    int64
	}
	sides := []side{
		{counts: positive, min: positiveMin},
		{counts: negative, min: negativeMin},
	}

	for {
		next := threshold
		for _, s := range sides {
			for i, count := range s.counts {
				if count == 0 {
					continue
				}
				index := s.min + int64(i)
				if compareBoundaryToThreshold(scale, index, threshold) < 0 &&
					compareBoundaryToThreshold(scale, index+1, threshold) > 0 {
					next = maxThreshold(next, thresholdFromBoundary(scale, index+1))
				}
			}
		}
		if compareThresholds(next, threshold) == 0 {
			break
		}
		threshold = next
	}

	for _, s := range sides {
		for i, count := range s.counts {
			if count == 0 {
				continue
			}
			index := s.min + int64(i)
			if compareBoundaryToThreshold(scale, index+1, threshold) <= 0 {
				var ok bool
				if *zeroCount, ok = add(*zeroCount, count); !ok {
					return dataeng.Threshold{}, fmt.Errorf("reference: zero count overflow on absorption")
				}
				s.counts[i] = 0
			}
		}
	}
	return threshold, nil
}

func trimDense(counts []uint64, min int64) dataeng.Group {
	first, last := -1, -1
	for i, count := range counts {
		if count != 0 {
			if first < 0 {
				first = i
			}
			last = i
		}
	}
	if first < 0 {
		return dataeng.Group{}
	}
	out := make([]uint64, last-first+1)
	copy(out, counts[first:last+1])
	return dataeng.Group{Offset: int32(min + int64(first)), Counts: out}
}

func floorDiv(v, divisor int64) int64 {
	q := v / divisor
	if v < 0 && v%divisor != 0 {
		q--
	}
	return q
}

func add(a, b uint64) (uint64, bool) {
	if b > ^uint64(0)-a {
		return 0, false
	}
	return a + b, true
}

type exponent struct {
	n int64
	d uint
}

func compareExponents(a, b exponent) int {
	var left, right big.Int
	left.SetInt64(a.n)
	left.Lsh(&left, b.d)
	right.SetInt64(b.n)
	right.Lsh(&right, a.d)
	return left.Cmp(&right)
}

func boundaryExponent(scale int, index int64) exponent {
	if scale >= 0 {
		return exponent{n: index, d: uint(scale)}
	}
	return exponent{n: index << uint(-scale)}
}

func compareBoundaryToThreshold(scale int, index int64, t dataeng.Threshold) int {
	if t.IsZero {
		return 1
	}
	return compareExponents(boundaryExponent(scale, index), exponent{n: t.N, d: uint(t.K)})
}

func compareThresholds(a, b dataeng.Threshold) int {
	if a.IsZero {
		if b.IsZero {
			return 0
		}
		return -1
	}
	if b.IsZero {
		return 1
	}
	return compareExponents(exponent{n: a.N, d: uint(a.K)}, exponent{n: b.N, d: uint(b.K)})
}

func maxThreshold(a, b dataeng.Threshold) dataeng.Threshold {
	if compareThresholds(a, b) >= 0 {
		return a
	}
	return b
}

func thresholdFromBoundary(scale int, index int64) dataeng.Threshold {
	if scale >= 0 {
		return canonicalThreshold(dataeng.NewThreshold(index, uint8(scale)))
	}
	return canonicalThreshold(dataeng.NewThreshold(index<<uint(-scale), 0))
}

func canonicalThreshold(t dataeng.Threshold) dataeng.Threshold {
	if t.IsZero {
		return dataeng.NewZeroThreshold()
	}
	return dataeng.NewThreshold(t.N, t.K)
}
