package formal

import (
	"testing"
	"time"
)

func TestConfigValidation(t *testing.T) {
	valid := DefaultConfig()
	if err := valid.Validate(); err != nil {
		t.Fatalf("default config is invalid: %v", err)
	}

	tests := map[string]func(*Config){
		"zero window": func(config *Config) {
			config.Route.Window = 0
		},
		"zero buckets": func(config *Config) {
			config.Instance.Buckets = 0
		},
		"sub-nanosecond bucket": func(config *Config) {
			config.Route.Window = time.Nanosecond
			config.Route.Buckets = 2
		},
		"zero requests": func(config *Config) {
			config.Route.MinRequests = 0
		},
		"invalid failure rate": func(config *Config) {
			config.Route.FailureRate = 1.1
		},
		"invalid slow rate": func(config *Config) {
			config.Instance.SlowRate = 0
		},
		"zero slow threshold": func(config *Config) {
			config.Instance.SlowThreshold = 0
		},
		"zero open timeout": func(config *Config) {
			config.Route.OpenTimeout = 0
		},
		"zero probe concurrency": func(config *Config) {
			config.Route.HalfOpenMaxConcurrent = 0
		},
		"zero probe successes": func(config *Config) {
			config.Instance.HalfOpenSuccesses = 0
		},
		"zero shared probes": func(config *Config) {
			config.SharedHalfOpenProbes = 0
		},
	}

	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			config := valid
			mutate(&config)
			if err := config.Validate(); err == nil {
				t.Fatal("Validate accepted invalid config")
			}
			if _, err := New(config); err == nil {
				t.Fatal("New accepted invalid config")
			}
		})
	}
}
