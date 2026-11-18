package formal

import (
	"errors"
	"fmt"
	"time"
)

const (
	defaultStartupSuccessThreshold   = 1
	defaultStartupFailureThreshold   = 3
	defaultReadinessSuccessThreshold = 2
	defaultReadinessFailureThreshold = 3
	defaultLivenessSuccessThreshold  = 2
	defaultLivenessFailureThreshold  = 3
	defaultBackoffBase               = 100 * time.Millisecond
	defaultBackoffMax                = 10 * time.Second
)

// Config controls threshold hysteresis and probe backoff.
//
// A zero value is valid and receives the documented defaults. Negative values
// are rejected. Success thresholds are the number of consecutive passes needed
// to enter (or re-enter) a passing condition; failure thresholds are the
// number of consecutive failures needed to leave it. Requiring more than one
// consecutive sample in both directions is what keeps a flapping instance from
// changing state on every probe.
type Config struct {
	StartupSuccessThreshold int
	StartupFailureThreshold int

	ReadinessSuccessThreshold int
	ReadinessFailureThreshold int

	LivenessSuccessThreshold int
	LivenessFailureThreshold int

	// BackoffBase is the delay after the first failure in a streak.
	BackoffBase time.Duration
	// BackoffMax caps the exponential backoff delay.
	BackoffMax time.Duration
}

// DefaultConfig returns the defaults used for zero-valued Config fields.
func DefaultConfig() Config {
	return Config{
		StartupSuccessThreshold:   defaultStartupSuccessThreshold,
		StartupFailureThreshold:   defaultStartupFailureThreshold,
		ReadinessSuccessThreshold: defaultReadinessSuccessThreshold,
		ReadinessFailureThreshold: defaultReadinessFailureThreshold,
		LivenessSuccessThreshold:  defaultLivenessSuccessThreshold,
		LivenessFailureThreshold:  defaultLivenessFailureThreshold,
		BackoffBase:               defaultBackoffBase,
		BackoffMax:                defaultBackoffMax,
	}
}

func (c Config) normalize() (Config, error) {
	defaults := DefaultConfig()

	fields := []struct {
		name string
		v    *int
		d    int
	}{
		{"StartupSuccessThreshold", &c.StartupSuccessThreshold, defaults.StartupSuccessThreshold},
		{"StartupFailureThreshold", &c.StartupFailureThreshold, defaults.StartupFailureThreshold},
		{"ReadinessSuccessThreshold", &c.ReadinessSuccessThreshold, defaults.ReadinessSuccessThreshold},
		{"ReadinessFailureThreshold", &c.ReadinessFailureThreshold, defaults.ReadinessFailureThreshold},
		{"LivenessSuccessThreshold", &c.LivenessSuccessThreshold, defaults.LivenessSuccessThreshold},
		{"LivenessFailureThreshold", &c.LivenessFailureThreshold, defaults.LivenessFailureThreshold},
	}
	for _, f := range fields {
		if *f.v < 0 {
			return Config{}, fmt.Errorf("formal: %s must not be negative", f.name)
		}
		if *f.v == 0 {
			*f.v = f.d
		}
	}

	if c.BackoffBase < 0 {
		return Config{}, errors.New("formal: BackoffBase must not be negative")
	}
	if c.BackoffMax < 0 {
		return Config{}, errors.New("formal: BackoffMax must not be negative")
	}
	if c.BackoffBase == 0 {
		c.BackoffBase = defaults.BackoffBase
	}
	if c.BackoffMax == 0 {
		c.BackoffMax = defaults.BackoffMax
	}
	if c.BackoffMax < c.BackoffBase {
		return Config{}, errors.New("formal: BackoffMax must be at least BackoffBase")
	}
	return c, nil
}

// BackoffDelay returns the exponential delay for a consecutive-failure streak.
// A streak of zero (or a negative input) means no delay. The result is capped
// at BackoffMax.
func (c Config) BackoffDelay(consecutiveFailures int) time.Duration {
	if consecutiveFailures <= 0 {
		return 0
	}
	base := c.BackoffBase
	maxDelay := c.BackoffMax
	if base <= 0 {
		base = defaultBackoffBase
	}
	if maxDelay < base {
		maxDelay = base
	}

	delay := base
	for n := 1; n < consecutiveFailures; n++ {
		if delay > maxDelay/2 {
			return maxDelay
		}
		delay *= 2
	}
	if delay > maxDelay {
		return maxDelay
	}
	return delay
}
