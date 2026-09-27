package telemetry

import (
	"math"
	"testing"
)

const eps = 1e-9

func almostEqual(a, b float64) bool { return math.Abs(a-b) < eps }

func checkReport(t *testing.T, rep Report, rate, increase float64, resets, drops int) {
	t.Helper()
	if !almostEqual(rep.Rate, rate) {
		t.Errorf("rate: got %v, want %v", rep.Rate, rate)
	}
	if !almostEqual(rep.Increase, increase) {
		t.Errorf("increase: got %v, want %v", rep.Increase, increase)
	}
	if rep.Resets != resets {
		t.Errorf("resets: got %d, want %d", rep.Resets, resets)
	}
	if rep.UncertainDrops != drops {
		t.Errorf("uncertain drops: got %d, want %d", rep.UncertainDrops, drops)
	}
}

// 100 -> 5 with a restart marker: the new epoch is computed as a fresh
// segment, delta at the reset is the new value (5), not -95.
func TestMarkedRestartStartsNewSegment(t *testing.T) {
	samples := []Sample{
		{T: 0, Value: 100},
		{T: 10, Value: 5, Reset: true},
		{T: 20, Value: 15},
	}
	rep, err := Rate(samples, 0, 20, KeepLast)
	if err != nil {
		t.Fatal(err)
	}
	// increase = 5 (restart) + 10 (5->15) = 15 over 20s
	checkReport(t, rep, 0.75, 15, 1, 0)
}

// 100 -> 5 without a marker: the drop is uncertain, contributes zero
// increase, and the rate never goes negative.
func TestUnmarkedRollbackIsUncertain(t *testing.T) {
	samples := []Sample{
		{T: 0, Value: 100},
		{T: 10, Value: 5},
		{T: 20, Value: 15},
	}
	rep, err := Rate(samples, 0, 20, KeepLast)
	if err != nil {
		t.Fatal(err)
	}
	// increase = 0 (uncertain drop) + 10 = 10 over 20s
	checkReport(t, rep, 0.5, 10, 0, 1)
	if rep.Rate < 0 {
		t.Errorf("negative rate fabricated: %v", rep.Rate)
	}
}

// A pure decrease with no marker yields zero increase, never a negative rate.
func TestNeverNegativeRate(t *testing.T) {
	samples := []Sample{
		{T: 0, Value: 100},
		{T: 10, Value: 50},
		{T: 20, Value: 20},
	}
	rep, err := Rate(samples, 0, 20, KeepLast)
	if err != nil {
		t.Fatal(err)
	}
	checkReport(t, rep, 0, 0, 0, 2)
}

// Duplicate timestamps with different values resolve per policy and are
// counted as conflicts.
func TestDuplicateTimestampConflictPolicies(t *testing.T) {
	base := []Sample{
		{T: 0, Value: 0},
		{T: 10, Value: 10},
		{T: 10, Value: 4}, // conflicting duplicate
		{T: 20, Value: 6},
	}
	cases := []struct {
		name   string
		policy ConflictPolicy
		want   float64 // rate over [0,20]
	}{
		{"keep-last", KeepLast, 0.3},   // 0 -> 4 -> 6: increase 6
		{"keep-first", KeepFirst, 0.5}, // 0 -> 10, then uncertain drop to 6
		{"keep-max", KeepMax, 0.5},     // same as keep-first here
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rep, err := Rate(base, 0, 20, tc.policy)
			if err != nil {
				t.Fatal(err)
			}
			if rep.Conflicts != 1 {
				t.Errorf("conflicts: got %d, want 1", rep.Conflicts)
			}
			if !almostEqual(rep.Rate, tc.want) {
				t.Errorf("rate: got %v, want %v", rep.Rate, tc.want)
			}
		})
	}
}

// Identical duplicates are not conflicts.
func TestIdenticalDuplicatesAreNotConflicts(t *testing.T) {
	samples := []Sample{
		{T: 0, Value: 0},
		{T: 10, Value: 10},
		{T: 10, Value: 10},
		{T: 20, Value: 20},
	}
	rep, err := Rate(samples, 0, 20, KeepLast)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Conflicts != 0 {
		t.Errorf("conflicts: got %d, want 0", rep.Conflicts)
	}
	checkReport(t, rep, 1, 20, 0, 0)
}

// Out-of-order delivery yields the same result as ordered input.
func TestOutOfOrderSamples(t *testing.T) {
	ordered := []Sample{
		{T: 0, Value: 0},
		{T: 10, Value: 40},
		{T: 20, Value: 3, Reset: true},
		{T: 30, Value: 13},
	}
	shuffled := []Sample{
		{T: 20, Value: 3, Reset: true},
		{T: 30, Value: 13},
		{T: 0, Value: 0},
		{T: 10, Value: 40},
	}
	a, err := Rate(ordered, 0, 30, KeepLast)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Rate(shuffled, 0, 30, KeepLast)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Errorf("order changed result: %+v vs %+v", a, b)
	}
	// increase = 40 + 3 (restart) + 10 = 53 over 30s
	checkReport(t, b, 53.0/30.0, 53, 1, 0)
}

// Window edges inside a segment are linearly interpolated.
func TestWindowEdgeInterpolation(t *testing.T) {
	samples := []Sample{
		{T: 0, Value: 0},
		{T: 10, Value: 100},
	}
	rep, err := Rate(samples, 2.5, 7.5, KeepLast)
	if err != nil {
		t.Fatal(err)
	}
	// interpolated edge values 25 and 75: increase 50 over 5s
	checkReport(t, rep, 10, 50, 0, 0)
	if !almostEqual(rep.Start, 2.5) || !almostEqual(rep.End, 7.5) {
		t.Errorf("window not preserved: [%v, %v]", rep.Start, rep.End)
	}
}

// A window edge in a reset gap holds the last known value instead of
// interpolating across epochs.
func TestResetGapUsesZeroOrderHold(t *testing.T) {
	samples := []Sample{
		{T: 0, Value: 100},
		{T: 10, Value: 5, Reset: true},
		{T: 20, Value: 25},
	}
	rep, err := Rate(samples, 5, 15, KeepLast)
	if err != nil {
		t.Fatal(err)
	}
	// edge at t=5 holds 100 (reset instant unknown); then restart adds 5,
	// then interpolation to t=15 gives 15: increase = 5 + 10 = 15 over 10s
	checkReport(t, rep, 1.5, 15, 1, 0)
}

// Windows are clamped to sample coverage.
func TestWindowClampedToCoverage(t *testing.T) {
	samples := []Sample{
		{T: 10, Value: 0},
		{T: 20, Value: 50},
	}
	rep, err := Rate(samples, 0, 100, KeepLast)
	if err != nil {
		t.Fatal(err)
	}
	if !almostEqual(rep.Start, 10) || !almostEqual(rep.End, 20) {
		t.Errorf("window not clamped: [%v, %v]", rep.Start, rep.End)
	}
	checkReport(t, rep, 5, 50, 0, 0)
}

func TestNoCoverage(t *testing.T) {
	samples := []Sample{{T: 10, Value: 0}, {T: 20, Value: 50}}
	if _, err := Rate(samples, 30, 40, KeepLast); err != ErrNoCoverage {
		t.Errorf("got %v, want ErrNoCoverage", err)
	}
	if _, err := Rate(nil, 0, 10, KeepLast); err != ErrNoCoverage {
		t.Errorf("got %v, want ErrNoCoverage", err)
	}
}

func TestInvalidWindow(t *testing.T) {
	samples := []Sample{{T: 0, Value: 0}, {T: 10, Value: 1}}
	if _, err := Rate(samples, 10, 10, KeepLast); err == nil {
		t.Error("expected error for empty window")
	}
	if _, err := Rate(samples, 20, 10, KeepLast); err == nil {
		t.Error("expected error for inverted window")
	}
}

// A reset flag on any duplicate survives conflict resolution.
func TestResetFlagSurvivesConflictResolution(t *testing.T) {
	samples := []Sample{
		{T: 0, Value: 100},
		{T: 10, Value: 5},
		{T: 10, Value: 7, Reset: true},
		{T: 20, Value: 17},
	}
	rep, err := Rate(samples, 0, 20, KeepFirst)
	if err != nil {
		t.Fatal(err)
	}
	// KeepFirst picks value 5 but keeps the Reset flag: increase = 5 + 12
	checkReport(t, rep, 0.85, 17, 1, 0)
	if rep.Conflicts != 1 {
		t.Errorf("conflicts: got %d, want 1", rep.Conflicts)
	}
}
