package formal

import (
	"fmt"
	"time"
)

// InstanceID identifies one backend instance.
type InstanceID string

// ProbeKind selects one of the three independent health signals.
type ProbeKind uint8

const (
	ProbeStartup ProbeKind = iota
	ProbeReadiness
	ProbeLiveness
)

func (k ProbeKind) String() string {
	switch k {
	case ProbeStartup:
		return "startup"
	case ProbeReadiness:
		return "readiness"
	case ProbeLiveness:
		return "liveness"
	default:
		return fmt.Sprintf("probe(%d)", uint8(k))
	}
}

// ProbeResult is the outcome of a single probe attempt.
type ProbeResult uint8

const (
	ProbePass ProbeResult = iota
	ProbeFail
)

func (r ProbeResult) String() string {
	switch r {
	case ProbePass:
		return "pass"
	case ProbeFail:
		return "fail"
	default:
		return fmt.Sprintf("result(%d)", uint8(r))
	}
}

// BoolResult converts a boolean success flag into a ProbeResult.
func BoolResult(ok bool) ProbeResult {
	if ok {
		return ProbePass
	}
	return ProbeFail
}

// State is the aggregated health state of one instance.
type State uint8

const (
	// StateStarting means the startup probe has not completed successfully.
	StateStarting State = iota
	// StateReady means the instance is allowed to receive traffic.
	StateReady
	// StateNotReady means the instance is alive but readiness is not passing.
	StateNotReady
	// StateUnhealthy means startup failed, or liveness failed after startup.
	StateUnhealthy
)

func (s State) String() string {
	switch s {
	case StateStarting:
		return "starting"
	case StateReady:
		return "ready"
	case StateNotReady:
		return "not-ready"
	case StateUnhealthy:
		return "unhealthy"
	default:
		return fmt.Sprintf("state(%d)", uint8(s))
	}
}

// TrafficEligible reports whether a state may receive load-balancer traffic.
func (s State) TrafficEligible() bool { return s == StateReady }

// ProbeStatus is the per-instance, per-probe-kind counter view.
//
// Attempts always equals Successes+Failures. Consecutive counters are the
// number of like outcomes at the end of the probe stream and never exceed
// Attempts. Counters belong to exactly one instance; probe results are never
// shared between instances.
type ProbeStatus struct {
	Attempts             int
	Successes            int
	Failures             int
	ConsecutiveSuccesses int
	ConsecutiveFailures  int
}

// Snapshot is an immutable view of one instance at one point in time.
type Snapshot struct {
	ID InstanceID

	State           State
	Ready           bool
	ReceivesTraffic bool

	StartupDone      bool
	StartupFailed    bool
	ReadinessPassing bool
	LivenessHealthy  bool

	Startup   ProbeStatus
	Readiness ProbeStatus
	Liveness  ProbeStatus

	// BackoffLevel is the largest active consecutive-failure streak across
	// startup (while still starting), readiness and liveness probes.
	BackoffLevel int
	// NextProbeDelay is the exponential delay implied by BackoffLevel.
	NextProbeDelay time.Duration
}
