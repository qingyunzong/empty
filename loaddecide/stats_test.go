package loaddecide

import (
	"math"
	"testing"
)

func approxEq(t *testing.T, name string, got, want, tol float64) {
	t.Helper()
	if math.Abs(got-want) > tol {
		t.Fatalf("%s = %v, want %v (tol %v)", name, got, want, tol)
	}
}

func TestInvNormal(t *testing.T) {
	approxEq(t, "median", invNormal(0.5), 0, 1e-9)
	approxEq(t, "p97.5", invNormal(0.975), 1.9599639845, 1e-6)
	approxEq(t, "p2.5", invNormal(0.025), -1.9599639845, 1e-6)
	approxEq(t, "p90", invNormal(0.90), 1.2815515655, 1e-6)
	approxEq(t, "p99.5", invNormal(0.995), 2.5758293035, 1e-6)
	if !math.IsInf(invNormal(0), -1) || !math.IsInf(invNormal(1), 1) {
		t.Fatalf("boundary probits must be infinite")
	}
}

func TestTCritical(t *testing.T) {
	// Standard t-table values for two-sided 95% confidence.
	approxEq(t, "t(10)", tCritical(0.95, 10), 2.228, 5e-3)
	approxEq(t, "t(30)", tCritical(0.95, 30), 2.042, 5e-3)
	approxEq(t, "t(1)", tCritical(0.95, 1), 12.706, 1e-2)
	// As degrees of freedom grow, t converges to the normal critical value.
	approxEq(t, "t(1000)~z", tCritical(0.95, 1000), 1.96, 1e-2)
	if !math.IsNaN(tCritical(0.95, 0)) {
		t.Fatalf("t with zero df must be NaN")
	}
}

func TestWilsonInterval(t *testing.T) {
	i := wilsonInterval(0, 100, 0.95)
	if i.Lower < -1e-12 || i.Upper <= 0 || i.Upper > 1 {
		t.Fatalf("zero-failure interval out of range: %+v", i)
	}
	allFail := wilsonInterval(50, 50, 0.95)
	if allFail.Lower <= 0 || allFail.Upper > 1 {
		t.Fatalf("all-failure interval out of range: %+v", allFail)
	}
	// A larger sample with the same proportion must produce a narrower interval.
	small := wilsonInterval(10, 100, 0.95)
	large := wilsonInterval(100, 1000, 0.95)
	if large.Width() >= small.Width() {
		t.Fatalf("Wilson width must shrink with n: small=%v large=%v", small.Width(), large.Width())
	}
	if !i.Contains(0) {
		t.Fatalf("zero-failure interval must contain 0")
	}
	if empty := wilsonInterval(0, 0, 0.95); !math.IsNaN(empty.Lower) {
		t.Fatalf("empty sample interval must be NaN")
	}
}

func TestQuantileConfidenceInterval(t *testing.T) {
	sorted := make([]float64, 500)
	for i := range sorted {
		sorted[i] = float64(i + 1)
	}
	q := quantileConfidenceInterval(sorted, 0.99, 0.95)
	if q.Lower >= q.Upper || q.Lower < 1 || q.Upper > 500 {
		t.Fatalf("invalid p99 interval: %+v", q.Interval)
	}
	approxEq(t, "p99 estimate", q.Estimate, 495.01, 0.05)

	// More samples must not widen the rank-based interval.
	big := make([]float64, 2000)
	for i := range big {
		big[i] = float64(i + 1)
	}
	qBig := quantileConfidenceInterval(big, 0.99, 0.95)
	bigWidth := (qBig.Upper - qBig.Lower) / 2000
	smallWidth := (q.Upper - q.Lower) / 500
	if bigWidth >= smallWidth {
		t.Fatalf("relative quantile CI width must shrink with n: %v vs %v", smallWidth, bigWidth)
	}

	// Tiny samples collapse to the extremes and are rejected by precision gates.
	tiny := quantileConfidenceInterval([]float64{1, 2}, 0.99, 0.95)
	if tiny.Lower < 1 || tiny.Upper > 2 || tiny.Upper <= tiny.Lower {
		t.Fatalf("tiny-sample interval must stay inside sample extremes: %+v", tiny)
	}
}

func TestMeanConfidenceIntervalShrinks(t *testing.T) {
	// Deterministic pseudo-normal samples around a fixed mean.
	makeSamples := func(n int) []float64 {
		out := make([]float64, n)
		seed := uint64(0x9e3779b97f4a7c15)
		for i := range out {
			seed ^= seed << 13
			seed ^= seed >> 7
			seed ^= seed << 17
			u := float64(seed>>11) / (1 << 53)
			out[i] = 100 + 10*invNormal(0.5+0.4999*(u-0.5))
		}
		return out
	}
	small := meanConfidenceInterval(makeSamples(20), 0.95)
	large := meanConfidenceInterval(makeSamples(2000), 0.95)
	if large.Width() >= small.Width() {
		t.Fatalf("mean CI must shrink with n: small=%v large=%v", small.Width(), large.Width())
	}
	if !small.Interval.Contains(small.Mean) || !large.Interval.Contains(100) {
		t.Fatalf("CI must contain its point estimate / true mean")
	}
	none := meanConfidenceInterval(nil, 0.95)
	if none.N != 0 || !math.IsNaN(none.Lower) {
		t.Fatalf("empty mean CI must be NaN")
	}
	one := meanConfidenceInterval([]float64{42}, 0.95)
	if one.Mean != 42 || !math.IsNaN(one.Upper) {
		t.Fatalf("single-sample CI must be NaN with mean 42")
	}
}
