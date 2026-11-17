package loaddecide

import (
	"errors"
	"testing"
)

func TestWarmupIsolation(t *testing.T) {
	c := NewCollector(0.95)
	for range 50 {
		if err := c.AddWarmup(Observation{LatencyMS: 999, Failed: false}); err != nil {
			t.Fatalf("warmup add: %v", err)
		}
	}
	c.BeginMeasured()
	err := c.AddWarmup(Observation{LatencyMS: 1})
	if !errors.Is(err, ErrWarmupClosed) {
		t.Fatalf("warmup after measured must fail with ErrWarmupClosed, got %v", err)
	}

	for i := range 100 {
		c.AddMeasured(Observation{LatencyMS: float64(10 + i%5), Failed: i%20 == 0})
	}
	c.AddWindow(ThroughputWindow{Requests: 100, Errors: 5})

	if c.WarmupRequests() != 50 || c.MeasuredRequests() != 100 {
		t.Fatalf("sample pools mixed: warmup=%d measured=%d", c.WarmupRequests(), c.MeasuredRequests())
	}
	stats, err := c.Snapshot(0, 0.99)
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	// Warmup latencies (999ms) must not influence the measured quantile.
	if stats.LatencyQuantile.Upper > 20 {
		t.Fatalf("warmup data leaked into measured stats: p99 upper=%v", stats.LatencyQuantile.Upper)
	}
	if stats.Requests != 100 || stats.Errors != 5 {
		t.Fatalf("unexpected counters: %+v", stats)
	}
}

func TestPrecisionGate(t *testing.T) {
	stats := LevelStats{
		Requests:        100,
		Errors:          1,
		ErrorRate:       Interval{Lower: 0, Upper: 0.04},
		LatencyQuantile: QuantileInterval{N: 99, Interval: Interval{Lower: 40, Upper: 60}},
		Throughput:      MeanInterval{N: 5, Interval: Interval{Lower: 90, Upper: 110}},
	}
	gate := PrecisionGate{Config: PrecisionConfig{
		MinWindows:           4,
		MinRequests:          50,
		MaxThroughputCIWidth: 25,
		MaxLatencyCIWidth:    25,
		MaxErrorCIWidth:      0.1,
	}}
	if ok, _ := gate.Sufficient(stats); !ok {
		t.Fatalf("stats should pass precision gate")
	}

	tooFew := stats
	tooFew.Requests = 10
	if ok, reason := gate.Sufficient(tooFew); ok || reason != ReasonInsufficientRequests {
		t.Fatalf("expected insufficient requests, got %v", reason)
	}

	wideCI := stats
	wideCI.Throughput = MeanInterval{N: 5, Interval: Interval{Lower: 80, Upper: 120}}
	if ok, reason := gate.Sufficient(wideCI); ok || reason != ReasonThroughputCIWide {
		t.Fatalf("expected wide throughput CI, got %v", reason)
	}

	nanCI := stats
	nanCI.ErrorRate = Interval{Lower: 0, Upper: nanSentinel()}
	if ok, reason := gate.Sufficient(nanCI); ok || reason != ReasonErrorCIWide {
		t.Fatalf("expected NaN error CI rejection, got %v", reason)
	}
}

func TestEvaluateSafetyConservative(t *testing.T) {
	gate := PrecisionGate{Config: PrecisionConfig{MinWindows: 3, MinRequests: 50}}
	slo := SLOConfig{
		MaxLatencyQuantileMS: 100,
		MaxErrorRate:         0.05,
		LatencyQuantile:      0.99,
		SaturationGainFloor:  0.05,
	}

	safe := LevelStats{
		Requests:        100,
		ErrorRate:       Interval{Lower: 0, Upper: 0.03},
		LatencyQuantile: QuantileInterval{Interval: Interval{Lower: 40, Upper: 90}},
		Throughput:      MeanInterval{N: 5, Interval: Interval{Lower: 95, Upper: 105}},
	}
	if v := EvaluateSafety(safe, gate, slo); v.Verdict != VerdictSafe {
		t.Fatalf("expected safe, got %v (%s)", v.Verdict, v.Reason)
	}

	latencyBad := safe
	latencyBad.LatencyQuantile.Upper = 130
	if v := EvaluateSafety(latencyBad, gate, slo); v.Verdict != VerdictUnsafe || v.Reason != ReasonLatencyBoundExceeded {
		t.Fatalf("expected latency violation, got %v (%s)", v.Verdict, v.Reason)
	}

	errorBad := safe
	errorBad.ErrorRate.Upper = 0.08
	if v := EvaluateSafety(errorBad, gate, slo); v.Verdict != VerdictUnsafe || v.Reason != ReasonErrorBoundExceeded {
		t.Fatalf("expected error-rate violation, got %v (%s)", v.Verdict, v.Reason)
	}

	unknown := safe
	unknown.Throughput.N = 1
	if v := EvaluateSafety(unknown, gate, slo); v.Verdict != VerdictUnknown {
		t.Fatalf("expected unknown under insufficient evidence, got %v", v.Verdict)
	}
}

func TestIsSaturated(t *testing.T) {
	prev := LevelStats{Throughput: MeanInterval{N: 10, Interval: Interval{Lower: 790, Upper: 810}}}

	// Overlapping CIs and gain at/below the floor means saturation.
	flat := LevelStats{Throughput: MeanInterval{N: 10, Interval: Interval{Lower: 800, Upper: 825}}}
	if !IsSaturated(prev, flat, 0.05) {
		t.Fatalf("flat overlapping CIs should be saturated")
	}

	// A confident, non-overlapping gain is not saturation.
	growing := LevelStats{Throughput: MeanInterval{N: 10, Interval: Interval{Lower: 900, Upper: 940}}}
	if IsSaturated(prev, growing, 0.05) {
		t.Fatalf("confident throughput growth must not be saturated")
	}

	// Overlapping but a strong point shift above the floor is not enough alone.
	strong := LevelStats{Throughput: MeanInterval{N: 10, Interval: Interval{Lower: 860, Upper: 880}}}
	if IsSaturated(prev, strong, 0.05) {
		t.Fatalf("gain above floor must not be saturated even with overlap")
	}
}

func nanSentinel() float64 {
	var z float64
	return z / z
}
