package dataeng

const (
	// MinScale and MaxScale are the inclusive limits for histogram scales.
	MinScale = -8
	MaxScale = 8

	// MinDenseSpan and MaxDenseSpan are the inclusive limits for the
	// per-side dense-span limit accepted by Merge.
	MinDenseSpan = 2
	MaxDenseSpan = 4096
)

// Threshold describes either the literal zero threshold or the value
// 2^(N/2^K). IsZero selects the literal zero meaning; otherwise N and K
// define the threshold. K must be in [0, 16].
//
// The zero value of Threshold is the threshold 2^0 = 1, not zero. Use
// NewZeroThreshold when a zero threshold is required.
type Threshold struct {
	IsZero bool
	N      int64
	K      uint8
}

// NewZeroThreshold returns the literal zero threshold.
func NewZeroThreshold() Threshold {
	return Threshold{IsZero: true}
}

// NewThreshold returns the canonical representation of 2^(n/2^k) for
// k <= 16. For k > 16 it preserves the invalid exponent so Merge can reject
// it. The constructor is useful for building canonical literals in examples.
func NewThreshold(n int64, k uint8) Threshold {
	if k > 16 {
		return Threshold{N: n, K: k}
	}
	return canonicalizeThreshold(Threshold{N: n, K: k})
}

// Group is one signed side of a histogram. Counts[j] is the count for
// absolute-value bucket Offset+j. The bucket is
// (B(scale, Offset+j), B(scale, Offset+j+1)].
//
// The negative side uses the same index ordering as the positive side. The
// caller interprets the sign; this package never reverses the negative
// array.
type Group struct {
	Offset int32
	Counts []uint64
}

// Histogram is an input histogram for one signed side pair.
type Histogram struct {
	Scale int

	Positive Group
	Negative Group

	// ZeroCount is the count of samples whose absolute values are <=
	// Threshold.
	ZeroCount uint64
	Threshold Threshold

	// Count is the supplied total and must equal the exact sum of all
	// ordinary buckets and ZeroCount.
	Count uint64
}

// MergeResult is a merged histogram at a scale common to all inputs.
type MergeResult struct {
	Scale     int
	Threshold Threshold
	Positive  Group
	Negative  Group
	ZeroCount uint64
	Count     uint64
}

// CapacityError reports that no candidate scale could satisfy MaxSpan.
// PositiveSpan and NegativeSpan are the required spans after threshold
// closure at scale -8. A side with no ordinary buckets has span zero.
type CapacityError struct {
	MaxSpan      int
	PositiveSpan int64
	NegativeSpan int64
	Scale        int
}

func (e *CapacityError) Error() string {
	return "dataeng: capacity insufficient at scale " +
		formatInt(e.Scale) + ": positive span " + formatInt64(e.PositiveSpan) +
		", negative span " + formatInt64(e.NegativeSpan) +
		", limit " + formatInt(e.MaxSpan)
}

// Unwrap lets callers test for capacity failures with errors.Is.
func (e *CapacityError) Unwrap() error {
	return ErrCapacity
}
