package formal

import (
	"errors"
	"fmt"
	"time"
)

// State is the admission state of a circuit breaker.
type State uint8

const (
	StateClosed State = iota
	StateOpen
	StateHalfOpen
)

func (s State) String() string {
	switch s {
	case StateClosed:
		return "closed"
	case StateOpen:
		return "open"
	case StateHalfOpen:
		return "half-open"
	default:
		return fmt.Sprintf("state(%d)", s)
	}
}

var (
	// ErrOpen is matched by both route and instance admission errors.
	ErrOpen = errors.New("formal: circuit is not admitting requests")
	// ErrRouteOpen means that the route breaker rejected the request.
	ErrRouteOpen = fmt.Errorf("formal: route: %w", ErrOpen)
	// ErrInstanceOpen means that the selected upstream instance rejected the
	// request. Such a rejection is never written to route statistics.
	ErrInstanceOpen = fmt.Errorf("formal: upstream instance: %w", ErrOpen)
)

// Policy configures one breaker layer. A breaker opens when either the failure
// rate or the slow-call rate reaches its configured threshold, provided that
// at least MinRequests samples are present in the sliding window.
type Policy struct {
	Window                time.Duration
	Buckets               int
	MinRequests           uint64
	FailureRate           float64
	SlowRate              float64
	SlowThreshold         time.Duration
	OpenTimeout           time.Duration
	HalfOpenMaxConcurrent int
	HalfOpenSuccesses     int
}

// DefaultPolicy returns a conservative policy suitable as a starting point.
func DefaultPolicy() Policy {
	return Policy{
		Window:                10 * time.Second,
		Buckets:               10,
		MinRequests:           20,
		FailureRate:           0.5,
		SlowRate:              0.5,
		SlowThreshold:         500 * time.Millisecond,
		OpenTimeout:           10 * time.Second,
		HalfOpenMaxConcurrent: 1,
		HalfOpenSuccesses:     3,
	}
}

func (p Policy) validate(layer string) error {
	switch {
	case p.Window <= 0:
		return fmt.Errorf("%s policy: window must be positive", layer)
	case p.Buckets <= 0:
		return fmt.Errorf("%s policy: buckets must be positive", layer)
	case p.Window/time.Duration(p.Buckets) <= 0:
		return fmt.Errorf("%s policy: bucket width must be at least one nanosecond", layer)
	case p.MinRequests == 0:
		return fmt.Errorf("%s policy: min requests must be positive", layer)
	case p.FailureRate <= 0 || p.FailureRate > 1:
		return fmt.Errorf("%s policy: failure rate must be in (0,1]", layer)
	case p.SlowRate <= 0 || p.SlowRate > 1:
		return fmt.Errorf("%s policy: slow rate must be in (0,1]", layer)
	case p.SlowThreshold <= 0:
		return fmt.Errorf("%s policy: slow threshold must be positive", layer)
	case p.OpenTimeout <= 0:
		return fmt.Errorf("%s policy: open timeout must be positive", layer)
	case p.HalfOpenMaxConcurrent <= 0:
		return fmt.Errorf("%s policy: half-open concurrency must be positive", layer)
	case p.HalfOpenSuccesses <= 0:
		return fmt.Errorf("%s policy: half-open successes must be positive", layer)
	default:
		return nil
	}
}

// Config configures the two breaker layers. SharedHalfOpenProbes is the total
// number of concurrent probes that a route and all of its instances may have in
// flight together.
type Config struct {
	Route                Policy
	Instance             Policy
	SharedHalfOpenProbes int
}

// DefaultConfig returns the default two-layer configuration.
func DefaultConfig() Config {
	return Config{
		Route:                DefaultPolicy(),
		Instance:             DefaultPolicy(),
		SharedHalfOpenProbes: 3,
	}
}

// Validate checks that all policy values are usable.
func (c Config) Validate() error {
	if err := c.Route.validate("route"); err != nil {
		return err
	}
	if err := c.Instance.validate("instance"); err != nil {
		return err
	}
	if c.SharedHalfOpenProbes <= 0 {
		return errors.New("config: shared half-open probes must be positive")
	}
	return nil
}

// Result describes one admitted upstream call.
type Result struct {
	Failed  bool
	Latency time.Duration
}

// Snapshot is a point-in-time view of one sliding window.
type Snapshot struct {
	State       State
	Total       uint64
	Failures    uint64
	SlowCalls   uint64
	FailureRate float64
	SlowRate    float64
}
