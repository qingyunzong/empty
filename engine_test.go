package formal_test

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"strings"
	"testing"

	"example.org/dlks/formal/q10190"
)

func baseConfig(metrics ...formal.MetricSpec) formal.Config {
	return formal.Config{
		Alpha:            0.05,
		Metrics:          metrics,
		MinSamplesPerArm: 100,
		TrafficSteps:     []float64{1, 5, 10, 25, 50, 100},
	}
}

func mustEngine(t *testing.T, cfg formal.Config) *formal.Engine {
	t.Helper()
	engine, err := formal.New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return engine
}

func bernoulli(r *rand.Rand, p float64, n int) []float64 {
	values := make([]float64, n)
	for i := range values {
		if r.Float64() < p {
			values[i] = 1
		}
	}
	return values
}

func ingestRange(t *testing.T, engine *formal.Engine, metric string, arm formal.Arm, prefix string, values []float64, from, to int) {
	t.Helper()
	batch := make([]formal.Observation, 0, to-from)
	for i := from; i < to; i++ {
		batch = append(batch, formal.Observation{
			Metric: metric,
			Arm:    arm,
			Value:  values[i],
			ID:     fmt.Sprintf("%s-%d", prefix, i),
		})
	}
	if err := engine.AddBatch(batch); err != nil {
		t.Fatalf("AddBatch(%s/%s): %v", metric, arm, err)
	}
}

func metricResult(t *testing.T, decision formal.Decision, name string) formal.MetricResult {
	t.Helper()
	for _, result := range decision.Metrics {
		if result.Name == name {
			return result
		}
	}
	t.Fatalf("metric %q not present in decision", name)
	return formal.MetricResult{}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func TestScaleUpOnSignificantImprovement(t *testing.T) {
	cfg := baseConfig(formal.MetricSpec{
		Name:             "success",
		Kind:             formal.KindProportion,
		Direction:        formal.HigherIsBetter,
		MinSamplesPerArm: 80,
	})
	engine := mustEngine(t, cfg)
	r := rand.New(rand.NewSource(11))
	control := bernoulli(r, 0.80, 400)
	treatment := bernoulli(r, 0.94, 400)

	sawScaleUp := false
	samples := 0
	for _, step := range []int{80, 40, 40, 40, 40, 80, 80} {
		ingestRange(t, engine, "success", formal.Control, "c", control, samples, samples+step)
		ingestRange(t, engine, "success", formal.Treatment, "t", treatment, samples, samples+step)
		samples += step
		decision := engine.Evaluate()
		t.Logf("n=%d action=%s reason=%s z=%.3f look=%d", samples, decision.Action, decision.Reason,
			metricResult(t, decision, "success").ZScore, decision.Look)
		if decision.Action == formal.ScaleUp {
			sawScaleUp = true
			if decision.NextTrafficPercent != 5 {
				t.Fatalf("first scale-up should target 5%%, got %v", decision.NextTrafficPercent)
			}
			break
		}
		if decision.Action == formal.Rollback {
			t.Fatalf("unexpected rollback for improving treatment: %s", decision.Reason)
		}
	}
	if !sawScaleUp {
		t.Fatal("treatment never scaled up despite a 14 point improvement")
	}

	if err := engine.Execute(formal.ScaleUp); err != nil {
		t.Fatalf("Execute(ScaleUp): %v", err)
	}
	if got := engine.TrafficPercent(); got != 5 {
		t.Fatalf("traffic after scale-up = %v, want 5", got)
	}
}

func TestHoldWhenArmsAreEquivalent(t *testing.T) {
	cfg := baseConfig(
		formal.MetricSpec{Name: "success", Kind: formal.KindProportion, Direction: formal.HigherIsBetter, MinSamplesPerArm: 100},
		formal.MetricSpec{Name: "latency", Kind: formal.KindContinuous, Direction: formal.LowerIsBetter, MinSamplesPerArm: 100},
	)
	engine := mustEngine(t, cfg)
	r := rand.New(rand.NewSource(23))
	controlSuccess := bernoulli(r, 0.88, 600)
	treatmentSuccess := bernoulli(r, 0.88, 600)
	controlLatency := make([]float64, 600)
	treatmentLatency := make([]float64, 600)
	for i := range controlLatency {
		controlLatency[i] = 120 + 12*r.NormFloat64()
		treatmentLatency[i] = 120 + 12*r.NormFloat64()
	}

	for samples := 100; samples <= 600; samples += 50 {
		ingestRange(t, engine, "success", formal.Control, "c", controlSuccess, samples-50, samples)
		ingestRange(t, engine, "success", formal.Treatment, "t", treatmentSuccess, samples-50, samples)
		ingestRange(t, engine, "latency", formal.Control, "c", controlLatency, samples-50, samples)
		ingestRange(t, engine, "latency", formal.Treatment, "t", treatmentLatency, samples-50, samples)
		decision := engine.Evaluate()
		if decision.Action != formal.Hold {
			t.Fatalf("n=%d: null streams produced %s (%s)", samples, decision.Action, decision.Reason)
		}
	}
}

func TestRollbackOnRegression(t *testing.T) {
	cfg := baseConfig(formal.MetricSpec{
		Name:             "success",
		Kind:             formal.KindProportion,
		Direction:        formal.HigherIsBetter,
		MinSamplesPerArm: 80,
	})
	engine := mustEngine(t, cfg)
	r := rand.New(rand.NewSource(31))
	control := bernoulli(r, 0.95, 120)
	treatment := bernoulli(r, 0.70, 120)
	ingestRange(t, engine, "success", formal.Control, "c", control, 0, 120)
	ingestRange(t, engine, "success", formal.Treatment, "t", treatment, 0, 120)

	decision := engine.Evaluate()
	if decision.Action != formal.Rollback {
		t.Fatalf("action = %s, want rollback: %s", decision.Action, decision.Reason)
	}
	if !contains(decision.HarmfulMetrics, "success") {
		t.Fatalf("harmful metrics = %v, want success", decision.HarmfulMetrics)
	}
	if decision.NextTrafficPercent != 0 {
		t.Fatalf("rollback target traffic = %v, want 0", decision.NextTrafficPercent)
	}
	if err := engine.Execute(decision.Action); err != nil {
		t.Fatalf("Execute(rollback): %v", err)
	}
	if got := engine.TrafficPercent(); got != 0 {
		t.Fatalf("traffic after rollback = %v, want 0", got)
	}
}

func TestMultiMetricRegressionWinsOverImprovement(t *testing.T) {
	cfg := baseConfig(
		formal.MetricSpec{Name: "success", Kind: formal.KindProportion, Direction: formal.HigherIsBetter, MinSamplesPerArm: 100, Weight: 1},
		formal.MetricSpec{Name: "latency", Kind: formal.KindContinuous, Direction: formal.LowerIsBetter, MinSamplesPerArm: 100, Weight: 1},
	)
	engine := mustEngine(t, cfg)
	r := rand.New(rand.NewSource(41))
	controlSuccess := bernoulli(r, 0.75, 140)
	treatmentSuccess := bernoulli(r, 0.95, 140)
	controlLatency := make([]float64, 140)
	treatmentLatency := make([]float64, 140)
	for i := range controlLatency {
		controlLatency[i] = 100 + 8*r.NormFloat64()
		treatmentLatency[i] = 135 + 8*r.NormFloat64()
	}

	ingestRange(t, engine, "success", formal.Control, "c", controlSuccess, 0, 140)
	ingestRange(t, engine, "success", formal.Treatment, "t", treatmentSuccess, 0, 140)
	ingestRange(t, engine, "latency", formal.Control, "c", controlLatency, 0, 140)
	ingestRange(t, engine, "latency", formal.Treatment, "t", treatmentLatency, 0, 140)

	decision := engine.Evaluate()
	if decision.Action != formal.Rollback {
		t.Fatalf("action = %s, want rollback: %s", decision.Action, decision.Reason)
	}
	if !contains(decision.HarmfulMetrics, "latency") {
		t.Fatalf("harmful metrics = %v, want latency", decision.HarmfulMetrics)
	}
	if !contains(decision.HelpfulMetrics, "success") {
		t.Fatalf("helpful metrics = %v, want success", decision.HelpfulMetrics)
	}
	if result := metricResult(t, decision, "latency"); result.Direction != formal.LowerIsBetter || !result.Regressed {
		t.Fatalf("latency result = %+v, want a significant regression", result)
	}
}

func TestMinimumSampleGate(t *testing.T) {
	cfg := baseConfig(formal.MetricSpec{
		Name:             "success",
		Kind:             formal.KindProportion,
		Direction:        formal.HigherIsBetter,
		MinSamplesPerArm: 100,
	})
	engine := mustEngine(t, cfg)
	r := rand.New(rand.NewSource(53))
	control := bernoulli(r, 0.99, 100)
	treatment := bernoulli(r, 0.01, 100)

	ingestRange(t, engine, "success", formal.Control, "c", control, 0, 99)
	ingestRange(t, engine, "success", formal.Treatment, "t", treatment, 0, 99)
	decision := engine.Evaluate()
	if decision.Action != formal.Hold || decision.Look != 0 {
		t.Fatalf("under minimum samples: action=%s look=%d, want hold/0", decision.Action, decision.Look)
	}
	result := metricResult(t, decision, "success")
	if result.Ready || result.Look != 0 || result.LookAlpha != 0 {
		t.Fatalf("under minimum samples: %+v, want not ready and no alpha spent", result)
	}

	ingestRange(t, engine, "success", formal.Control, "c", control, 99, 100)
	ingestRange(t, engine, "success", formal.Treatment, "t", treatment, 99, 100)
	decision = engine.Evaluate()
	if decision.Action != formal.Rollback || decision.Look != 1 {
		t.Fatalf("at minimum samples: action=%s look=%d, want rollback/1", decision.Action, decision.Look)
	}
}

func TestOneScaleUpPerExecutedStep(t *testing.T) {
	cfg := formal.Config{
		Alpha:        0.05,
		Metrics:      []formal.MetricSpec{{Name: "success", Kind: formal.KindProportion, Direction: formal.HigherIsBetter, MinSamplesPerArm: 10}},
		TrafficSteps: []float64{10, 20},
	}
	engine := mustEngine(t, cfg)
	if got := engine.TrafficPercent(); got != 10 {
		t.Fatalf("initial traffic = %v, want 10", got)
	}
	if err := engine.Execute(formal.ScaleUp); err != nil {
		t.Fatalf("scale to max: %v", err)
	}
	if got := engine.TrafficPercent(); got != 20 {
		t.Fatalf("traffic = %v, want 20", got)
	}
	if err := engine.Execute(formal.ScaleUp); err != nil {
		t.Fatalf("scale at max should be a no-op: %v", err)
	}
	if got := engine.TrafficPercent(); got != 20 {
		t.Fatalf("traffic above max = %v, want 20", got)
	}
}

func TestReasonMentionsPendingMetric(t *testing.T) {
	cfg := baseConfig(
		formal.MetricSpec{Name: "a", Kind: formal.KindProportion, Direction: formal.HigherIsBetter, MinSamplesPerArm: 50},
		formal.MetricSpec{Name: "b", Kind: formal.KindProportion, Direction: formal.HigherIsBetter, MinSamplesPerArm: 50},
	)
	engine := mustEngine(t, cfg)
	r := rand.New(rand.NewSource(61))
	values := bernoulli(r, 0.8, 50)
	ingestRange(t, engine, "a", formal.Control, "c", values, 0, 50)
	ingestRange(t, engine, "a", formal.Treatment, "t", values, 0, 50)
	decision := engine.Evaluate()
	if decision.Action != formal.Hold || !strings.Contains(decision.Reason, "minimum") {
		t.Fatalf("decision = %+v, want hold waiting for metric b", decision)
	}
	if len(decision.PendingMetrics) != 1 || decision.PendingMetrics[0] != "b" {
		t.Fatalf("pending = %v, want [b]", decision.PendingMetrics)
	}
}

func TestMaxSamplesFinal(t *testing.T) {
	cfg := baseConfig(formal.MetricSpec{
		Name:             "latency",
		Kind:             formal.KindContinuous,
		Direction:        formal.LowerIsBetter,
		MinSamplesPerArm: 10,
		MaxSamplesPerArm: 20,
	})
	engine := mustEngine(t, cfg)
	values := make([]float64, 20)
	for i := range values {
		values[i] = 100
	}
	ingestRange(t, engine, "latency", formal.Control, "c", values, 0, 10)
	ingestRange(t, engine, "latency", formal.Treatment, "t", values, 0, 10)
	if decision := engine.Evaluate(); decision.Final {
		t.Fatal("Final set before maximum samples")
	}
	ingestRange(t, engine, "latency", formal.Control, "c", values, 10, 20)
	ingestRange(t, engine, "latency", formal.Treatment, "t", values, 10, 20)
	decision := engine.Evaluate()
	if !decision.Final || decision.Action != formal.Hold {
		t.Fatalf("decision = %+v, want final hold", decision)
	}
}

func TestDecisionJSONIsFinite(t *testing.T) {
	cfg := baseConfig(formal.MetricSpec{
		Name:             "latency",
		Kind:             formal.KindContinuous,
		Direction:        formal.HigherIsBetter,
		MinSamplesPerArm: 2,
	})
	engine := mustEngine(t, cfg)
	values := []float64{10, 10, 20, 20}
	ingestRange(t, engine, "latency", formal.Control, "c", values, 0, 2)
	ingestRange(t, engine, "latency", formal.Treatment, "t", values, 2, 4)
	// Constant arms with different means produce effectively infinite evidence;
	// the public result still has to be JSON encodable.
	decision := engine.Evaluate()
	if _, err := json.Marshal(decision); err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
}
