// Package telemetry computes rates from cumulative counter samples.
//
// It handles the messy parts of real counters:
//   - restarts: a sample flagged Reset opens a new epoch; the counter is
//     assumed to have restarted at 0, so the delta is the sample value
//     itself, never a negative spike;
//   - unmarked rollbacks: a decrease without a Reset flag cannot be
//     distinguished from data corruption, so it contributes zero increase
//     and is reported as uncertain — a negative rate is never fabricated;
//   - out-of-order delivery: samples are sorted by time before use;
//   - duplicate timestamps with different values: resolved by a
//     configurable ConflictPolicy and counted in the report;
//   - window edges: counter values at the window boundaries are
//     interpolated (linear inside a segment, zero-order hold across a
//     reset gap, where the reset instant is unknown).
package telemetry

import (
	"errors"
	"fmt"
	"sort"
)

// Sample is a single observation of a cumulative counter.
type Sample struct {
	// T is the observation time in seconds on any monotonic epoch.
	T float64
	// Value is the cumulative counter value.
	Value float64
	// Reset marks the first sample of a new counter epoch (restart).
	Reset bool
}

// ConflictPolicy decides how duplicate timestamps carrying different
// values are resolved.
type ConflictPolicy int

const (
	// KeepLast keeps the last sample received for a timestamp.
	KeepLast ConflictPolicy = iota
	// KeepFirst keeps the first sample received for a timestamp.
	KeepFirst
	// KeepMax keeps the largest value seen for a timestamp.
	KeepMax
)

// ErrNoCoverage is returned when the window does not overlap the data.
var ErrNoCoverage = errors.New("telemetry: window outside sample coverage")

// Report summarizes a rate computation over a window.
type Report struct {
	Rate           float64 // counter increase per second
	Increase       float64 // total increase attributed to the window
	Start, End     float64 // effective window after clamping to coverage
	Resets         int     // marked restarts inside the window
	UncertainDrops int     // unmarked decreases inside the window
	Conflicts      int     // timestamps that carried differing values
}

// Normalize sorts samples by time and collapses duplicate timestamps
// according to policy. It returns the normalized series and the number of
// conflicting timestamps (timestamps observed with more than one distinct
// value). A Reset flag on any duplicate is preserved.
func Normalize(samples []Sample, policy ConflictPolicy) ([]Sample, int) {
	sorted := make([]Sample, len(samples))
	copy(sorted, samples)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].T < sorted[j].T })

	out := make([]Sample, 0, len(sorted))
	conflicts := 0
	for i := 0; i < len(sorted); {
		j := i + 1
		for j < len(sorted) && sorted[j].T == sorted[i].T {
			j++
		}
		group := sorted[i:j]

		chosen := group[0]
		switch policy {
		case KeepLast:
			chosen = group[len(group)-1]
		case KeepMax:
			for _, s := range group[1:] {
				if s.Value > chosen.Value {
					chosen = s
				}
			}
		}
		differ := false
		reset := false
		for _, s := range group {
			reset = reset || s.Reset
			if s.Value != group[0].Value {
				differ = true
			}
		}
		chosen.Reset = reset
		if differ {
			conflicts++
		}
		out = append(out, chosen)
		i = j
	}
	return out, conflicts
}

// valueAt estimates the counter value at t within a normalized series.
//
// Inside a segment the value is linearly interpolated between the
// neighbouring samples. If t falls in a gap that straddles a reset (the
// next sample opens a new epoch), the last known value is held, because
// the reset instant inside the gap is unknown and interpolation across
// epochs is meaningless.
func valueAt(series []Sample, t float64) float64 {
	i := sort.Search(len(series), func(i int) bool { return series[i].T > t })
	if i == 0 {
		return series[0].Value
	}
	prev := series[i-1]
	if prev.T == t || i == len(series) {
		return prev.Value
	}
	next := series[i]
	if next.Reset {
		return prev.Value
	}
	frac := (t - prev.T) / (next.T - prev.T)
	return prev.Value + frac*(next.Value-prev.Value)
}

// Rate computes the counter rate over the window [start, end].
//
// The window is clamped to the coverage of the series; if there is no
// overlap, ErrNoCoverage is returned. Samples may arrive out of order.
func Rate(samples []Sample, start, end float64, policy ConflictPolicy) (Report, error) {
	if end <= start {
		return Report{}, fmt.Errorf("telemetry: invalid window [%v, %v]", start, end)
	}
	series, conflicts := Normalize(samples, policy)
	if len(series) == 0 {
		return Report{}, ErrNoCoverage
	}
	lo := maxf(start, series[0].T)
	hi := minf(end, series[len(series)-1].T)
	if hi <= lo {
		return Report{}, ErrNoCoverage
	}

	// Effective point series: interpolated window edges plus every
	// sample strictly inside the window.
	points := []Sample{{T: lo, Value: valueAt(series, lo)}}
	for _, s := range series {
		if s.T > lo && s.T <= hi {
			points = append(points, s)
		}
	}
	if points[len(points)-1].T < hi {
		points = append(points, Sample{T: hi, Value: valueAt(series, hi)})
	}

	rep := Report{Start: lo, End: hi, Conflicts: conflicts}
	for i := 1; i < len(points); i++ {
		prev, cur := points[i-1], points[i]
		switch {
		case cur.Reset:
			// Marked restart: new epoch, counter assumed to restart at 0.
			rep.Increase += cur.Value
			rep.Resets++
		case cur.Value >= prev.Value:
			rep.Increase += cur.Value - prev.Value
		default:
			// Unmarked rollback: possibly a reset, possibly corruption.
			// Count nothing; never fabricate a negative rate.
			rep.UncertainDrops++
		}
	}
	rep.Rate = rep.Increase / (hi - lo)
	return rep, nil
}

func minf(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func maxf(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}
