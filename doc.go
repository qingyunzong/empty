// Package dataeng merges exponential histograms from a telemetry acquisition
// pipeline without access to raw samples.
//
// Buckets use the boundary B(s,i)=2^(i*2^-s), where the integer scale s is in
// [-8,8]. Positive and negative sides are bucketized by absolute value. The
// caller assigns the sign; this package never reverses the negative side.
//
// Thresholds are either zero or 2^(n/2^k), with k in [0,16]. All boundary and
// threshold ordering decisions use exact rational-exponent comparisons backed
// by integer arithmetic. The implementation never evaluates a power or uses a
// floating-point logarithm.
//
// Use Merge for the complete pipeline operation. MergeAtScale is the fixed
// candidate operation, and CombineAtScale exposes the same fixed-scale
// building block without a span limit. The reference subpackage contains an
// independent, deliberately unfolded implementation for small tests.
package dataeng
