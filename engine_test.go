package formal

import "testing"

func baseConfig() Config {
	return Config{
		MinReplicas: 1,
		MaxReplicas: 100,
		Metrics: []MetricSpec{
			{Name: "cpu", Target: 100},
			{Name: "mem", Target: 200},
		},
	}
}

func TestMetricAggregationMultiMetric(t *testing.T) {
	c := NewController(baseConfig())
	// pod a: both metrics; pod b: cpu only (missing mem); pod c: unready
	// with huge values that must be ignored; pod d: ready, no samples.
	c.AddSample(10, "a", "cpu", 100)
	c.AddSample(10, "a", "mem", 400)
	c.AddSample(10, "b", "cpu", 300)
	c.AddSample(10, "c", "cpu", 10000)
	c.AddSample(10, "c", "mem", 10000)
	c.SetPodReady("c", false)

	// cpu: ceil(4 * 400 / (2 * 100)) = 8; mem: ceil(4 * 400 / (1 * 200)) = 8.
	rec := c.Evaluate(20, 4)
	if rec.Desired != 8 || rec.Replicas != 8 {
		t.Fatalf("got %+v, want desired=8 replicas=8", rec)
	}
}

func TestMetricAggregationCeilAndMissing(t *testing.T) {
	cfg := baseConfig()
	cfg.Metrics = []MetricSpec{{Name: "cpu", Target: 100}}
	c := NewController(cfg)
	c.AddSample(1, "a", "cpu", 101)
	// ceil(1 * 101 / 100) = 2.
	if rec := c.Evaluate(2, 1); rec.Desired != 2 {
		t.Fatalf("ceil: got %+v, want desired=2", rec)
	}

	// No metric data at all: desire stays at current replicas.
	c2 := NewController(cfg)
	if rec := c2.Evaluate(2, 7); rec.Desired != 7 || rec.Replicas != 7 {
		t.Fatalf("no data: got %+v, want 7", rec)
	}
}

func TestOutOfOrderSamples(t *testing.T) {
	cfg := baseConfig()
	cfg.Metrics = []MetricSpec{{Name: "cpu", Target: 100}}
	c := NewController(cfg)
	c.AddSample(100, "a", "cpu", 500)
	// Older sample arriving later must not overwrite the newer one.
	c.AddSample(50, "a", "cpu", 10000)
	// Equal timestamp: later arrival wins.
	c.AddSample(100, "a", "cpu", 200)
	if rec := c.Evaluate(100, 1); rec.Desired != 2 {
		t.Fatalf("got %+v, want desired=2 (ts=100, value=200)", rec)
	}
}

func TestScaleDownStabilizationMostConservative(t *testing.T) {
	cfg := baseConfig()
	cfg.Metrics = []MetricSpec{{Name: "cpu", Target: 100}}
	cfg.ScaleDown.StabilizationWindowSeconds = 100
	c := NewController(cfg)

	c.AddSample(0, "a", "cpu", 100)
	if rec := c.Evaluate(0, 10); rec.Replicas != 10 {
		t.Fatalf("t=0: got %+v, want 10", rec)
	}
	// Load drops; raw desire is 2 but the window still holds 10.
	c.AddSample(10, "a", "cpu", 20)
	for _, ts := range []int64{10, 50, 100} {
		if rec := c.Evaluate(ts, 10); rec.Replicas != 10 {
			t.Fatalf("t=%d: got %+v, want 10 (conservative window)", ts, rec)
		}
	}
	// At t=101 the t=0 entry aged out (age 101 > 100); window max is 2.
	if rec := c.Evaluate(101, 10); rec.Replicas != 2 {
		t.Fatalf("t=101: got %+v, want 2 after expiry", rec)
	}
}

func TestScaleUpStabilizationSmallest(t *testing.T) {
	cfg := baseConfig()
	cfg.Metrics = []MetricSpec{{Name: "cpu", Target: 100}}
	cfg.ScaleUp.StabilizationWindowSeconds = 100
	c := NewController(cfg)

	c.AddSample(0, "a", "cpu", 100)
	if rec := c.Evaluate(0, 2); rec.Replicas != 2 {
		t.Fatalf("t=0: got %+v, want 2", rec)
	}
	// Spike to 20: scale up takes the window minimum, still 2.
	c.AddSample(10, "a", "cpu", 1000)
	if rec := c.Evaluate(10, 2); rec.Replicas != 2 {
		t.Fatalf("t=10: got %+v, want 2 (window min)", rec)
	}
	// After the t=0 entry expires, the spike recommendation stands.
	if rec := c.Evaluate(101, 2); rec.Replicas != 20 {
		t.Fatalf("t=101: got %+v, want 20", rec)
	}
}

func TestPreciseEvictionBoundary(t *testing.T) {
	cfg := baseConfig()
	cfg.Metrics = []MetricSpec{{Name: "cpu", Target: 100}}
	cfg.ScaleDown.StabilizationWindowSeconds = 100
	c := NewController(cfg)

	c.AddSample(0, "a", "cpu", 100)
	c.Evaluate(0, 10) // history: (0,10)
	c.AddSample(10, "a", "cpu", 20)
	c.Evaluate(10, 10) // history: (0,10),(10,2)
	c.Evaluate(50, 10) // history: (0,10),(10,2),(50,2)

	// t=100: the t=0 entry has age exactly 100 and must be kept.
	if rec := c.Evaluate(100, 10); rec.Replicas != 10 {
		t.Fatalf("t=100: got %+v, want 10 (boundary entry kept)", rec)
	}
	if got := c.HistoryLen(); got != 4 {
		t.Fatalf("t=100 history len: got %d, want 4", got)
	}
	// t=101: age 101 > 100, entry evicted.
	if rec := c.Evaluate(101, 10); rec.Replicas != 2 {
		t.Fatalf("t=101: got %+v, want 2 (boundary entry evicted)", rec)
	}
	if got := c.HistoryLen(); got != 4 {
		t.Fatalf("t=101 history len: got %d, want 4", got)
	}
}

func TestRatePoliciesPodsAndPercent(t *testing.T) {
	cfg := baseConfig()
	cfg.Metrics = []MetricSpec{{Name: "cpu", Target: 100}}
	cfg.ScaleUp.Policies = []ScalingPolicy{
		{Type: PodsPolicy, Value: 4, PeriodSeconds: 10},
	}
	c := NewController(cfg)
	c.AddSample(0, "a", "cpu", 100000)

	// First evaluation gets a full period of allowance: +4.
	if rec := c.Evaluate(0, 10); rec.Replicas != 14 {
		t.Fatalf("first eval: got %+v, want 14", rec)
	}
	// 5s of a 10s period: allowance floor(4*5/10) = 2.
	if rec := c.Evaluate(5, 14); rec.Replicas != 16 {
		t.Fatalf("t=5: got %+v, want 16", rec)
	}
	// 15s elapsed: allowance floor(4*15/10) = 6.
	if rec := c.Evaluate(20, 16); rec.Replicas != 22 {
		t.Fatalf("t=20: got %+v, want 22", rec)
	}
	// Backwards time jump grants no allowance.
	if rec := c.Evaluate(3, 22); rec.Replicas != 22 {
		t.Fatalf("backwards jump: got %+v, want 22", rec)
	}
}

func TestRatePolicyPercentAndSelect(t *testing.T) {
	cfg := baseConfig()
	cfg.Metrics = []MetricSpec{{Name: "cpu", Target: 100}}
	cfg.ScaleUp.Policies = []ScalingPolicy{
		{Type: PodsPolicy, Value: 4, PeriodSeconds: 10},
		{Type: PercentPolicy, Value: 100, PeriodSeconds: 10}, // 10 pods at current=10
	}
	c := NewController(cfg)
	c.AddSample(0, "a", "cpu", 100000)

	// Default MaxSelect: percent policy allows 10.
	if rec := c.Evaluate(0, 10); rec.Replicas != 20 {
		t.Fatalf("max select: got %+v, want 20", rec)
	}

	cfg.ScaleUp.SelectPolicy = MinSelect
	c2 := NewController(cfg)
	c2.AddSample(0, "a", "cpu", 100000)
	// MinSelect: pods policy limit of 4 wins.
	if rec := c2.Evaluate(0, 10); rec.Replicas != 14 {
		t.Fatalf("min select: got %+v, want 14", rec)
	}

	cfg.ScaleUp.SelectPolicy = DisabledSelect
	c3 := NewController(cfg)
	c3.AddSample(0, "a", "cpu", 100000)
	if rec := c3.Evaluate(0, 10); rec.Replicas != 10 {
		t.Fatalf("disabled: got %+v, want 10", rec)
	}
}

func TestRatePolicyScaleDown(t *testing.T) {
	cfg := baseConfig()
	cfg.Metrics = []MetricSpec{{Name: "cpu", Target: 100}}
	cfg.ScaleDown.Policies = []ScalingPolicy{
		{Type: PodsPolicy, Value: 3, PeriodSeconds: 10},
	}
	c := NewController(cfg)
	c.AddSample(0, "a", "cpu", 1)
	if rec := c.Evaluate(0, 10); rec.Replicas != 7 {
		t.Fatalf("got %+v, want 7 (down limit 3)", rec)
	}
}

func TestReplicaBoundaries(t *testing.T) {
	cfg := baseConfig()
	cfg.MinReplicas = 2
	cfg.MaxReplicas = 5
	cfg.Metrics = []MetricSpec{{Name: "cpu", Target: 100}}
	c := NewController(cfg)

	c.AddSample(0, "a", "cpu", 100000)
	if rec := c.Evaluate(0, 3); rec.Replicas != 5 {
		t.Fatalf("clamp max: got %+v, want 5", rec)
	}

	c2 := NewController(cfg)
	c2.AddSample(0, "a", "cpu", 0)
	if rec := c2.Evaluate(0, 3); rec.Replicas != 2 {
		t.Fatalf("clamp min: got %+v, want 2", rec)
	}

	// Current replicas outside bounds are pulled back into range.
	c3 := NewController(cfg)
	if rec := c3.Evaluate(0, 10); rec.Replicas != 5 {
		t.Fatalf("current above max: got %+v, want 5", rec)
	}
}

func TestUnreadyPodExclusionFlips(t *testing.T) {
	cfg := baseConfig()
	cfg.Metrics = []MetricSpec{{Name: "cpu", Target: 100}}
	c := NewController(cfg)
	c.AddSample(0, "a", "cpu", 100)
	c.AddSample(0, "b", "cpu", 300)

	if rec := c.Evaluate(1, 2); rec.Desired != 4 {
		t.Fatalf("both ready: got %+v, want desired=4", rec)
	}
	c.SetPodReady("b", false)
	if rec := c.Evaluate(2, 2); rec.Desired != 2 {
		t.Fatalf("b unready: got %+v, want desired=2", rec)
	}
	c.SetPodReady("b", true)
	if rec := c.Evaluate(3, 2); rec.Desired != 4 {
		t.Fatalf("b ready again: got %+v, want desired=4", rec)
	}
}
