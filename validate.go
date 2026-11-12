package dataeng

import (
	"fmt"
	"math"
)

// ValidateHistogram checks structural validity, exact total-count agreement,
// and the input threshold rule for ordinary buckets. It does not modify the
// histogram.
func ValidateHistogram(h Histogram) error {
	if h.Scale < MinScale || h.Scale > MaxScale {
		return invalidf("scale %d outside [%d,%d]", h.Scale, MinScale, MaxScale)
	}
	if err := validateThreshold(h.Threshold); err != nil {
		return err
	}
	if err := validateGroup(h.Positive, "positive", h.Scale, h.Threshold); err != nil {
		return err
	}
	if err := validateGroup(h.Negative, "negative", h.Scale, h.Threshold); err != nil {
		return err
	}

	var total uint64
	var overflow bool
	if total, overflow = addUint64(total, h.ZeroCount); overflow {
		return overflowf("zero count in histogram")
	}
	for _, c := range h.Positive.Counts {
		if total, overflow = addUint64(total, c); overflow {
			return overflowf("positive bucket counts in histogram")
		}
	}
	for _, c := range h.Negative.Counts {
		if total, overflow = addUint64(total, c); overflow {
			return overflowf("negative bucket counts in histogram")
		}
	}
	if total != h.Count {
		return invalidf("count=%d does not equal bucket sum %d", h.Count, total)
	}
	return nil
}

func validateGroup(g Group, side string, scale int, threshold Threshold) error {
	if len(g.Counts) == 0 {
		if g.Offset != 0 {
			return invalidf("%s empty group has offset=%d, want 0", side, g.Offset)
		}
		return nil
	}

	// Avoid forming offset+len-1 before checking it.
	maxLen := int64(math.MaxInt32) - int64(g.Offset) + 1
	if int64(len(g.Counts)) > maxLen {
		return invalidf("%s offset %d and array length %d exceed int32 index range",
			side, g.Offset, len(g.Counts))
	}
	last := int64(g.Offset) + int64(len(g.Counts)) - 1
	if last < int64(math.MinInt32) || last > int64(math.MaxInt32) {
		return invalidf("%s offset %d and last index %d exceed int32 index range",
			side, g.Offset, last)
	}

	if threshold.IsZero {
		return nil
	}
	for j, c := range g.Counts {
		if c == 0 {
			continue
		}
		index := int64(g.Offset) + int64(j)
		if compareBoundaryToThreshold(scale, index, threshold) < 0 {
			return invalidf("%s nonzero bucket at index %d has lower boundary below threshold", side, index)
		}
	}
	return nil
}

func addUint64(a, b uint64) (uint64, bool) {
	if b > math.MaxUint64-a {
		return 0, true
	}
	return a + b, false
}

func validateInputs(hs []Histogram) error {
	for i := range hs {
		if err := ValidateHistogram(hs[i]); err != nil {
			return fmt.Errorf("histogram %d: %w", i, err)
		}
	}
	return nil
}
