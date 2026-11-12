package dataeng

import (
	"math"
	"sort"
)

// Merge merges a set of histograms, choosing the highest feasible common
// scale from min(input scales) down to -8. The selected scale is feasible
// only when, after threshold closure, each side's nonzero-index span is at
// most maxSpan.
//
// An input slice with length zero is a special case and returns scale 8.
func Merge(hs []Histogram, maxSpan int) (MergeResult, error) {
	if maxSpan < MinDenseSpan || maxSpan > MaxDenseSpan {
		return MergeResult{}, invalidf("max span %d outside [%d,%d]",
			maxSpan, MinDenseSpan, MaxDenseSpan)
	}
	if len(hs) == 0 {
		return MergeResult{
			Scale:     MaxScale,
			Threshold: NewZeroThreshold(),
			Positive:  Group{},
			Negative:  Group{},
			ZeroCount: 0,
			Count:     0,
		}, nil
	}
	if err := validateInputs(hs); err != nil {
		return MergeResult{}, err
	}

	firstScale := hs[0].Scale
	for i := 1; i < len(hs); i++ {
		if hs[i].Scale < firstScale {
			firstScale = hs[i].Scale
		}
	}

	var lastFailure *CapacityError
	for scale := firstScale; scale >= MinScale; scale-- {
		result, posSpan, negSpan, err := mergeAtScale(hs, scale, int64(maxSpan))
		if err != nil {
			return MergeResult{}, err
		}
		if posSpan > int64(maxSpan) || negSpan > int64(maxSpan) {
			lastFailure = &CapacityError{
				MaxSpan:      maxSpan,
				PositiveSpan: posSpan,
				NegativeSpan: negSpan,
				Scale:        scale,
			}
			continue
		}
		return result, nil
	}
	return MergeResult{}, lastFailure
}

// MergeAtScale performs the merge and threshold closure at exactly scale.
// Every input must already be at or finer than scale. It applies the same
// maxSpan check as Merge but does not search for another scale.
func MergeAtScale(hs []Histogram, scale, maxSpan int) (MergeResult, error) {
	if maxSpan < MinDenseSpan || maxSpan > MaxDenseSpan {
		return MergeResult{}, invalidf("max span %d outside [%d,%d]",
			maxSpan, MinDenseSpan, MaxDenseSpan)
	}
	if scale < MinScale || scale > MaxScale {
		return MergeResult{}, invalidf("scale %d outside [%d,%d]",
			scale, MinScale, MaxScale)
	}
	if len(hs) == 0 {
		return MergeResult{
			Scale:     scale,
			Threshold: NewZeroThreshold(),
			Positive:  Group{},
			Negative:  Group{},
		}, nil
	}
	if err := validateInputs(hs); err != nil {
		return MergeResult{}, err
	}
	for i := range hs {
		if hs[i].Scale < scale {
			return MergeResult{}, invalidf("histogram %d scale %d cannot be upscaled to %d",
				i, hs[i].Scale, scale)
		}
	}

	result, posSpan, negSpan, err := mergeAtScale(hs, scale, int64(maxSpan))
	if err != nil {
		return MergeResult{}, err
	}
	if posSpan > int64(maxSpan) || negSpan > int64(maxSpan) {
		return MergeResult{}, &CapacityError{
			MaxSpan:      maxSpan,
			PositiveSpan: posSpan,
			NegativeSpan: negSpan,
			Scale:        scale,
		}
	}
	return result, nil
}

// CombineAtScale is the fixed-scale building block used when a pipeline
// groups histograms first. It performs downscaling, threshold closure, and
// canonical trimming without imposing a maximum span. The result is a valid
// Histogram at the requested scale and can be merged again at that same
// scale.
func CombineAtScale(hs []Histogram, scale int) (Histogram, error) {
	if scale < MinScale || scale > MaxScale {
		return Histogram{}, invalidf("scale %d outside [%d,%d]",
			scale, MinScale, MaxScale)
	}
	if len(hs) == 0 {
		return Histogram{
			Scale:     scale,
			Threshold: NewZeroThreshold(),
			Positive:  Group{},
			Negative:  Group{},
		}, nil
	}
	if err := validateInputs(hs); err != nil {
		return Histogram{}, err
	}
	for i := range hs {
		if hs[i].Scale < scale {
			return Histogram{}, invalidf("histogram %d scale %d cannot be upscaled to %d",
				i, hs[i].Scale, scale)
		}
	}
	result, _, _, err := mergeAtScale(hs, scale, 0)
	if err != nil {
		return Histogram{}, err
	}
	return Histogram{
		Scale:     result.Scale,
		Threshold: result.Threshold,
		Positive:  result.Positive,
		Negative:  result.Negative,
		ZeroCount: result.ZeroCount,
		Count:     result.Count,
	}, nil
}

// mergeAtScale always starts again from the original inputs. It returns the
// closed result plus both side spans, whether or not those spans fit any
// limit.
func mergeAtScale(hs []Histogram, scale int, maxSpan int64) (MergeResult, int64, int64, error) {
	positive := make(map[int32]uint64)
	negative := make(map[int32]uint64)

	var zeroCount uint64
	var totalCount uint64
	var threshold = NewZeroThreshold()

	for i := range hs {
		h := &hs[i]
		if h.Scale < scale {
			return MergeResult{}, 0, 0, invalidf("histogram %d scale %d cannot be upscaled to %d",
				i, h.Scale, scale)
		}
		if err := mergeGroup(positive, h.Positive, h.Scale, scale); err != nil {
			return MergeResult{}, 0, 0, err
		}
		if err := mergeGroup(negative, h.Negative, h.Scale, scale); err != nil {
			return MergeResult{}, 0, 0, err
		}

		var overflow bool
		if zeroCount, overflow = addUint64(zeroCount, h.ZeroCount); overflow {
			return MergeResult{}, 0, 0, overflowf("zero counts while merging")
		}
		if totalCount, overflow = addUint64(totalCount, h.Count); overflow {
			return MergeResult{}, 0, 0, overflowf("total counts while merging")
		}
		threshold = maxThreshold(threshold, h.Threshold)
	}

	closedThreshold, err := closeThreshold(scale, threshold, &zeroCount, positive, negative)
	if err != nil {
		return MergeResult{}, 0, 0, err
	}

	positiveGroup, positiveSpan := canonicalGroup(positive, maxSpan)
	negativeGroup, negativeSpan := canonicalGroup(negative, maxSpan)
	return MergeResult{
		Scale:     scale,
		Threshold: closedThreshold,
		Positive:  positiveGroup,
		Negative:  negativeGroup,
		ZeroCount: zeroCount,
		Count:     totalCount,
	}, positiveSpan, negativeSpan, nil
}

func mergeGroup(dst map[int32]uint64, g Group, sourceScale, targetScale int) error {
	if len(g.Counts) == 0 {
		return nil
	}
	d := uint(sourceScale - targetScale)
	for j, c := range g.Counts {
		if c == 0 {
			continue
		}
		index := int64(g.Offset) + int64(j)
		target := floorDivPow2(index, d)
		if target < math.MinInt32 || target > math.MaxInt32 {
			return invalidf("downscaled index %d outside int32 range", target)
		}
		key := int32(target)
		sum, overflow := addUint64(dst[key], c)
		if overflow {
			return overflowf("positive/negative bucket at index %d while merging", key)
		}
		dst[key] = sum
	}
	return nil
}

func floorDivPow2(v int64, d uint) int64 {
	if d == 0 {
		return v
	}
	divisor := int64(1) << d
	q := v / divisor
	if v < 0 && v%divisor != 0 {
		q--
	}
	return q
}

func closeThreshold(scale int, threshold Threshold, zeroCount *uint64,
	sides ...map[int32]uint64) (Threshold, error) {
	if threshold.IsZero {
		return threshold, nil
	}

	// First raise T to the largest upper boundary among all nonzero buckets
	// strictly containing T. Repeating is required because a later crossing
	// may see a bucket whose lower boundary was above the old T.
	for {
		next := threshold
		for _, side := range sides {
			for index, count := range side {
				if count == 0 {
					continue
				}
				lower := int64(index)
				upper := lower + 1
				if compareBoundaryToThreshold(scale, lower, threshold) < 0 &&
					compareBoundaryToThreshold(scale, upper, threshold) > 0 {
					candidate := thresholdFromBoundary(scale, upper)
					next = maxThreshold(next, candidate)
				}
			}
		}
		if compareThresholds(next, threshold) == 0 {
			break
		}
		threshold = next
	}

	// upper == T is absorbed. lower == T is deliberately not absorbed: its
	// bucket starts immediately above T, so its ordinary samples are still
	// strictly greater than T.
	for _, side := range sides {
		for index, count := range side {
			if count == 0 {
				continue
			}
			if compareBoundaryToThreshold(scale, int64(index)+1, threshold) <= 0 {
				var overflow bool
				if *zeroCount, overflow = addUint64(*zeroCount, count); overflow {
					return Threshold{}, overflowf("bucket absorption into zero count at index %d", index)
				}
				delete(side, index)
			}
		}
	}
	return canonicalizeThreshold(threshold), nil
}

func canonicalGroup(m map[int32]uint64, maxSpan int64) (Group, int64) {
	if len(m) == 0 {
		return Group{}, 0
	}
	indices := make([]int32, 0, len(m))
	for index := range m {
		indices = append(indices, index)
	}
	sort.Slice(indices, func(i, j int) bool { return indices[i] < indices[j] })

	first, last := indices[0], indices[len(indices)-1]
	span := int64(last) - int64(first) + 1
	if maxSpan > 0 && span > maxSpan {
		// The caller only needs the span for a capacity decision. Do not
		// allocate a potentially enormous dense array for a failed side.
		return Group{}, span
	}
	counts := make([]uint64, int(span))
	for _, index := range indices {
		counts[int64(index)-int64(first)] = m[index]
	}
	return Group{Offset: first, Counts: counts}, span
}
