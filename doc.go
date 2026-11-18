// Package formal provides an embeddable, deterministic health aggregator for
// load balancers.
//
// Each instance reports three independent probe streams: startup, readiness
// and liveness. The aggregator turns those streams into one of four states:
//
//	StateStarting  startup probe has not succeeded yet
//	StateReady     startup completed, liveness healthy, readiness passing
//	StateNotReady  startup completed and alive, but readiness is not passing
//	StateUnhealthy startup failed, or liveness failed after startup
//
// Only StateReady instances receive traffic. Consecutive successes and
// failures are tracked with separate thresholds so a flapping probe stream
// cannot move an instance back and forth on every sample. Failure streaks also
// drive an exponential probe backoff.
//
// The package is safe for concurrent use and does not use wall-clock time;
// callers decide when to feed probe results and how to apply the reported
// next-probe delay.
package formal
