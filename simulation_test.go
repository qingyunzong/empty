package formal_test

import (
	"fmt"
	"math/rand"
	"testing"

	"example.org/dlks/formal/q10190"
)

type nullStreams struct {
	control   map[string][]float64
	treatment map[string][]float64
}

// newNullStreams draws both arms from the same distribution. Success and error
// are generated from one latent uniform per unit, so the metrics are strongly
// dependent; latency is independent. The false-alarm bound must not rely on
// metric independence.
func newNullStreams(r *rand.Rand, n int) nullStreams {
	s := nullStreams{
		control:   map[string][]float64{"success": make([]float64, n), "error": make([]float64, n), "latency": make([]float64, n)},
		treatment: map[string][]float64{"success": make([]float64, n), "error": make([]float64, n), "latency": make([]float64, n)},
	}
	for i := 0; i < n; i++ {
		uc, ut := r.Float64(), r.Float64()
		if uc < 0.90 {
			s.control["success"][i] = 1
		}
		if ut < 0.90 {
			s.treatment["success"][i] = 1
		}
		if uc < 0.04 {
			s.control["error"][i] = 1
		}
		if ut < 0.04 {
			s.treatment["error"][i] = 1
		}
		s.control["latency"][i] = 100 + 10*r.NormFloat64()
		s.treatment["latency"][i] = 100 + 10*r.NormFloat64()
	}
	return s
}

func nullConfig(alpha float64) formal.Config {
	return formal.Config{
		Alpha: alpha,
		Metrics: []formal.MetricSpec{
			{Name: "success", Kind: formal.KindProportion, Direction: formal.HigherIsBetter, MinSamplesPerArm: 100, Weight: 1},
			{Name: "error", Kind: formal.KindProportion, Direction: formal.LowerIsBetter, MinSamplesPerArm: 100, Weight: 1},
			{Name: "latency", Kind: formal.KindContinuous, Direction: formal.LowerIsBetter, MinSamplesPerArm: 100, Weight: 1},
		},
		TrafficSteps: []float64{1, 5, 10, 25, 50, 100},
	}
}

func runNullTrials(t *testing.T, alpha float64, trials int, seed int64) (falseAlarms, falseRollbacks int) {
	t.Helper()
	r := rand.New(rand.NewSource(seed))
	cfg := nullConfig(alpha)
	for trial := 0; trial < trials; trial++ {
		engine := mustEngine(t, cfg)
		streams := newNullStreams(r, 200)
		previous := 0
		for _, samples := range []int{100, 150, 200} {
			for _, metric := range []string{"success", "error", "latency"} {
				ingestRange(t, engine, metric, formal.Control, "c", streams.control[metric], previous, samples)
				ingestRange(t, engine, metric, formal.Treatment, "t", streams.treatment[metric], previous, samples)
			}
			previous = samples
			decision := engine.Evaluate()
			if decision.Action != formal.Hold {
				falseAlarms++
				if decision.Action == formal.Rollback {
					falseRollbacks++
				}
				break
			}
		}
	}
	return falseAlarms, falseRollbacks
}

func TestFamilyWiseFalseAlarmBound(t *testing.T) {
	const (
		alpha  = 0.05
		trials = 1000
	)
	falseAlarms, falseRollbacks := runNullTrials(t, alpha, trials, 101)
	rate := float64(falseAlarms) / trials
	rollbackRate := float64(falseRollbacks) / trials
	t.Logf("alpha=%.2f trials=%d false alarms=%d (%.4f) false rollbacks=%d (%.4f)",
		alpha, trials, falseAlarms, rate, falseRollbacks, rollbackRate)
	if rate > alpha+0.015 {
		t.Fatalf("family-wise false-alarm rate %.4f exceeds alpha %.2f plus simulation margin", rate, alpha)
	}
	if rollbackRate > alpha {
		t.Fatalf("false rollback rate %.4f exceeds alpha %.2f", rollbackRate, alpha)
	}
}

func TestFalseAlarmBoundScalesWithAlpha(t *testing.T) {
	const (
		alpha  = 0.20
		trials = 600
	)
	falseAlarms, _ := runNullTrials(t, alpha, trials, 202)
	rate := float64(falseAlarms) / trials
	t.Logf("alpha=%.2f trials=%d false alarms=%d (%.4f)", alpha, trials, falseAlarms, rate)
	if rate > alpha+0.015 {
		t.Fatalf("false-alarm rate %.4f exceeds alpha %.2f plus simulation margin", rate, alpha)
	}
}

func TestDecisionIsReproducible(t *testing.T) {
	cfg := baseConfig(
		formal.MetricSpec{Name: "success", Kind: formal.KindProportion, Direction: formal.HigherIsBetter, MinSamplesPerArm: 80},
		formal.MetricSpec{Name: "latency", Kind: formal.KindContinuous, Direction: formal.LowerIsBetter, MinSamplesPerArm: 80},
	)
	build := func(seed int64) []formal.Decision {
		engine := mustEngine(t, cfg)
		r := rand.New(rand.NewSource(seed))
		controlSuccess := bernoulli(r, 0.82, 200)
		treatmentSuccess := bernoulli(r, 0.91, 200)
		controlLatency := make([]float64, 200)
		treatmentLatency := make([]float64, 200)
		for i := range controlLatency {
			controlLatency[i] = 110 + 9*r.NormFloat64()
			treatmentLatency[i] = 108 + 9*r.NormFloat64()
		}
		var decisions []formal.Decision
		previous := 0
		for _, samples := range []int{80, 120, 160, 200} {
			ingestRange(t, engine, "success", formal.Control, "c", controlSuccess, previous, samples)
			ingestRange(t, engine, "success", formal.Treatment, "t", treatmentSuccess, previous, samples)
			ingestRange(t, engine, "latency", formal.Control, "c", controlLatency, previous, samples)
			ingestRange(t, engine, "latency", formal.Treatment, "t", treatmentLatency, previous, samples)
			previous = samples
			decisions = append(decisions, engine.Evaluate())
		}
		return decisions
	}

	first, second := build(303), build(303)
	if len(first) != len(second) {
		t.Fatalf("decision counts differ: %d vs %d", len(first), len(second))
	}
	for i := range first {
		if fmt.Sprint(first[i]) != fmt.Sprint(second[i]) {
			t.Fatalf("decision %d differs:\nfirst:  %+v\nsecond: %+v", i, first[i], second[i])
		}
	}
}
