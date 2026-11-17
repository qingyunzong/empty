package formal_test

import (
	"testing"

	"example.org/dlks/formal/q10190"
)

func TestConfigValidation(t *testing.T) {
	valid := formal.MetricSpec{Name: "m", Kind: formal.KindProportion, Direction: formal.HigherIsBetter, MinSamplesPerArm: 10}
	cases := []struct {
		name string
		cfg  formal.Config
	}{
		{"zero alpha", formal.Config{Metrics: []formal.MetricSpec{valid}}},
		{"alpha one", formal.Config{Alpha: 1, Metrics: []formal.MetricSpec{valid}}},
		{"no metrics", formal.Config{Alpha: 0.05}},
		{"empty name", formal.Config{Alpha: 0.05, Metrics: []formal.MetricSpec{{Kind: formal.KindProportion, Direction: formal.HigherIsBetter}}}},
		{"duplicate name", formal.Config{Alpha: 0.05, Metrics: []formal.MetricSpec{valid, valid}}},
		{"bad kind", formal.Config{Alpha: 0.05, Metrics: []formal.MetricSpec{{Name: "m", Kind: "rate", Direction: formal.HigherIsBetter}}}},
		{"bad direction", formal.Config{Alpha: 0.05, Metrics: []formal.MetricSpec{{Name: "m", Kind: formal.KindProportion, Direction: "up"}}}},
		{"one sample", formal.Config{Alpha: 0.05, Metrics: []formal.MetricSpec{{Name: "m", Kind: formal.KindProportion, Direction: formal.HigherIsBetter, MinSamplesPerArm: 1}}}},
		{"max below min", formal.Config{Alpha: 0.05, Metrics: []formal.MetricSpec{{Name: "m", Kind: formal.KindProportion, Direction: formal.HigherIsBetter, MinSamplesPerArm: 10, MaxSamplesPerArm: 5}}}},
		{"negative weight", formal.Config{Alpha: 0.05, Metrics: []formal.MetricSpec{{Name: "m", Kind: formal.KindProportion, Direction: formal.HigherIsBetter, Weight: -1}}}},
		{"unsorted traffic", formal.Config{Alpha: 0.05, Metrics: []formal.MetricSpec{valid}, TrafficSteps: []float64{10, 5}}},
		{"zero traffic", formal.Config{Alpha: 0.05, Metrics: []formal.MetricSpec{valid}, TrafficSteps: []float64{0, 5}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.cfg.Validate(); err == nil {
				t.Fatal("Validate succeeded, want error")
			}
			if _, err := formal.New(tc.cfg); err == nil {
				t.Fatal("New succeeded, want error")
			}
		})
	}
}

func TestDefaultMinimumSamples(t *testing.T) {
	cfg := formal.Config{
		Alpha:   0.05,
		Metrics: []formal.MetricSpec{{Name: "m", Kind: formal.KindProportion, Direction: formal.HigherIsBetter}},
	}
	engine, err := formal.New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if engine == nil {
		t.Fatal("nil engine")
	}
}
