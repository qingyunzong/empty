package formal_test

import (
	"math"
	"testing"
	"time"

	"example.org/dlks/formal/q10187"
)

func TestConfigValidation(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*formal.Config)
		valid  bool
	}{
		{name: "base", valid: true},
		{name: "zero width", mutate: func(c *formal.Config) { c.BucketWidth = 0 }},
		{name: "short below width", mutate: func(c *formal.Config) {
			c.ShortWindow = 30 * time.Second
		}},
		{name: "long below short", mutate: func(c *formal.Config) {
			c.LongWindow = 4 * time.Minute
		}},
		{name: "short misaligned", mutate: func(c *formal.Config) {
			c.ShortWindow = 90 * time.Second
		}},
		{name: "long misaligned", mutate: func(c *formal.Config) {
			c.LongWindow = 10*time.Minute + 30*time.Second
		}},
		{name: "zero fire", mutate: func(c *formal.Config) { c.FireThreshold = 0 }},
		{name: "NaN fire", mutate: func(c *formal.Config) { c.FireThreshold = math.NaN() }},
		{name: "infinite fire", mutate: func(c *formal.Config) { c.FireThreshold = math.Inf(1) }},
		{name: "negative recover", mutate: func(c *formal.Config) { c.RecoverThreshold = -1 }},
		{name: "recover equals fire", mutate: func(c *formal.Config) { c.RecoverThreshold = c.FireThreshold }},
		{name: "zero coverage", mutate: func(c *formal.Config) { c.MinCoverage = 0 }},
		{name: "coverage above one", mutate: func(c *formal.Config) { c.MinCoverage = 1.1 }},
		{name: "negative staleness", mutate: func(c *formal.Config) { c.MaxStaleness = -time.Second }},
		{name: "negative dwell", mutate: func(c *formal.Config) { c.RecoverFor = -time.Second }},
		{name: "bad targets", mutate: func(c *formal.Config) { c.Targets.Default = 1 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := baseConfig()
			if tc.mutate != nil {
				tc.mutate(&cfg)
			}
			err := cfg.Validate()
			if tc.valid && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !tc.valid && err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestAccessorsAndBatchIngest(t *testing.T) {
	start := mustTime(t, "2026-11-18T10:00:00Z")
	clock := formal.NewManualClock(start)
	cfg := baseConfig()
	evaluator, err := formal.NewEvaluator(cfg, clock)
	if err != nil {
		t.Fatal(err)
	}

	if got := evaluator.Store().Width(); got != time.Minute {
		t.Fatalf("store width = %s", got)
	}
	cfg.Targets.Daily = map[string]float64{"2026-11-18": 0.9}
	copied := evaluator.Config()
	if _, exists := copied.Targets.Daily["2026-11-18"]; exists {
		t.Fatal("evaluator retained caller's target map")
	}
	copied.Targets.Daily = map[string]float64{"2026-11-17": 0.9}
	if _, exists := evaluator.Config().Targets.Daily["2026-11-17"]; exists {
		t.Fatal("Config returned an aliased target map")
	}

	changed, err := evaluator.IngestAll(
		formal.Bucket{Start: start, Total: 10, Errors: 1},
		formal.Bucket{Start: start.Add(time.Minute), Total: 10, Errors: 2},
	)
	if err != nil || changed != 2 {
		t.Fatalf("IngestAll changed=%d err=%v", changed, err)
	}
	changed, err = evaluator.IngestAll(formal.Bucket{Start: start, Total: 10, Errors: 1})
	if err != nil || changed != 0 {
		t.Fatalf("duplicate IngestAll changed=%d err=%v", changed, err)
	}
	if latest, ok := evaluator.Store().Latest(); !ok || !latest.Start.Equal(start.Add(time.Minute)) {
		t.Fatalf("latest = %+v, ok=%v", latest, ok)
	}
	if bucket, ok := evaluator.Store().Get(start); !ok || bucket.Errors != 1 {
		t.Fatalf("get = %+v, ok=%v", bucket, ok)
	}

	if evaluator.State() != formal.AlertInactive {
		t.Fatalf("initial state = %s", evaluator.State())
	}
	if formal.AlertInactive.String() != "inactive" ||
		formal.AlertFiring.String() != "firing" ||
		formal.AlertState(9).String() != "AlertState(9)" {
		t.Fatal("unexpected alert state strings")
	}
	if formal.TransitionNone.String() != "none" ||
		formal.TransitionFired.String() != "fired" ||
		formal.TransitionCleared.String() != "cleared" ||
		formal.Transition(9).String() != "Transition(9)" {
		t.Fatal("unexpected transition strings")
	}

	clock.Set(start.Add(5 * time.Minute))
	if !clock.Now().Equal(start.Add(5 * time.Minute)) {
		t.Fatalf("clock now = %s", clock.Now())
	}
}

func TestZeroTrafficIsUsableAndHasZeroBurn(t *testing.T) {
	start := mustTime(t, "2026-11-18T10:00:00Z")
	cfg := baseConfig()
	cfg.MaxStaleness = time.Minute
	evaluator := newEvaluator(t, cfg)
	seed(t, evaluator, start, 10, time.Minute, 0, 0)

	result := evaluate(t, evaluator, start.Add(10*time.Minute))
	if !result.DataOK {
		t.Fatal("complete zero-traffic buckets should be usable")
	}
	if result.Short.BurnRate != 0 || result.Long.BurnRate != 0 {
		t.Fatalf("zero-traffic burn = %v/%v", result.Short.BurnRate, result.Long.BurnRate)
	}
	if result.Firing() {
		t.Fatal("zero traffic fired")
	}
}
