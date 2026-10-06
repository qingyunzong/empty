// Package breaker implements a three-state (closed/open/half-open) circuit
// breaker with generation-scoped result reporting.
//
// State machine:
//
//	closed  --FailureThreshold consecutive failures--> open
//	open    --OpenDuration elapses (Clock)-->         half-open
//	half-open --RequiredSuccesses probe successes-->  closed
//	half-open --any probe failure-->                  open
//
// Every state transition bumps a generation counter. A Permit carries the
// generation in which it was issued; results reported against a stale
// generation are ignored, so a late success from an old half-open episode
// can never close a newly opened generation.
package breaker

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// ErrOpen is returned by Acquire while the breaker is open and the cooldown
// has not yet elapsed: normal requests are explicitly rejected.
var ErrOpen = errors.New("breaker: circuit open, request rejected")

// ErrProbeLimit is returned by Acquire in half-open state when MaxProbes
// probes are already in flight.
var ErrProbeLimit = errors.New("breaker: half-open probe limit reached")

// State is the circuit breaker state.
type State int

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
	}
	return fmt.Sprintf("state(%d)", int(s))
}

// Clock supplies the current time. Tests substitute a controlled clock.
type Clock interface {
	Now() time.Time
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

// Options configures a Breaker. Zero-valued fields get defaults:
// FailureThreshold=5, OpenDuration=30s, MaxProbes=1,
// RequiredSuccesses=MaxProbes, Clock=real time.
type Options struct {
	// FailureThreshold is the number of consecutive failures in the closed
	// state that trips the breaker open.
	FailureThreshold int
	// OpenDuration is how long the breaker stays open before allowing
	// half-open probes.
	OpenDuration time.Duration
	// MaxProbes (K) is the maximum number of concurrent probe requests
	// admitted while half-open.
	MaxProbes int
	// RequiredSuccesses is the number of successful probes in one half-open
	// episode required to close the breaker again.
	RequiredSuccesses int
	// Clock overrides the time source; nil means time.Now.
	Clock Clock
}

// Breaker is a concurrency-safe three-state circuit breaker.
type Breaker struct {
	mu sync.Mutex

	clock             Clock
	failureThreshold  int
	openDuration      time.Duration
	maxProbes         int
	requiredSuccesses int

	state               State
	generation          uint64
	consecutiveFailures int
	openedAt            time.Time
	probesInFlight      int
	probeSuccesses      int
}

// New returns a Breaker in the closed state.
func New(opts Options) *Breaker {
	if opts.FailureThreshold <= 0 {
		opts.FailureThreshold = 5
	}
	if opts.OpenDuration <= 0 {
		opts.OpenDuration = 30 * time.Second
	}
	if opts.MaxProbes <= 0 {
		opts.MaxProbes = 1
	}
	if opts.RequiredSuccesses <= 0 {
		opts.RequiredSuccesses = opts.MaxProbes
	}
	if opts.Clock == nil {
		opts.Clock = realClock{}
	}
	return &Breaker{
		clock:             opts.Clock,
		failureThreshold:  opts.FailureThreshold,
		openDuration:      opts.OpenDuration,
		maxProbes:         opts.MaxProbes,
		requiredSuccesses: opts.RequiredSuccesses,
		state:             StateClosed,
	}
}

// State returns the current state, transitioning open -> half-open first if
// the cooldown has elapsed.
func (b *Breaker) State() State {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.maybeEnterHalfOpenLocked()
	return b.state
}

// Generation returns the current generation counter. It increments on every
// state transition; results from older generations are ignored.
func (b *Breaker) Generation() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.generation
}

// Permit represents an admitted request. Exactly one of Success or Failure
// must be called when the request settles; later calls are no-ops.
type Permit struct {
	b          *Breaker
	generation uint64
	probe      bool
	done       bool
}

// Acquire admits a request according to the current state:
//   - closed: every request is admitted.
//   - open: rejected with ErrOpen until OpenDuration has elapsed, after
//     which the breaker becomes half-open.
//   - half-open: up to MaxProbes concurrent probes are admitted; further
//     calls fail with ErrProbeLimit.
func (b *Breaker) Acquire() (*Permit, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	switch b.state {
	case StateOpen:
		if !b.maybeEnterHalfOpenLocked() {
			return nil, ErrOpen
		}
	case StateClosed:
		return &Permit{b: b, generation: b.generation}, nil
	}

	// Half-open: admit a probe if a slot is free.
	if b.probesInFlight >= b.maxProbes {
		return nil, ErrProbeLimit
	}
	b.probesInFlight++
	return &Permit{b: b, generation: b.generation, probe: true}, nil
}

// Success reports a successful outcome for the permitted request.
func (p *Permit) Success() { p.b.report(p, true) }

// Failure reports a failed outcome for the permitted request.
func (p *Permit) Failure() { p.b.report(p, false) }

func (b *Breaker) report(p *Permit, success bool) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if p.done {
		return
	}
	p.done = true

	// Only results from the current generation may affect state. A late
	// result from a previous generation (e.g. a slow probe that settles
	// after the breaker already re-opened) is dropped.
	if p.generation != b.generation {
		return
	}

	if p.probe {
		b.probesInFlight--
		if success {
			b.probeSuccesses++
			if b.probeSuccesses >= b.requiredSuccesses {
				b.transitionLocked(StateClosed)
			}
		} else {
			b.transitionLocked(StateOpen)
		}
		return
	}

	if success {
		b.consecutiveFailures = 0
		return
	}
	b.consecutiveFailures++
	if b.consecutiveFailures >= b.failureThreshold {
		b.transitionLocked(StateOpen)
	}
}

// maybeEnterHalfOpenLocked transitions open -> half-open once the cooldown
// has elapsed. It reports whether the breaker is now half-open.
func (b *Breaker) maybeEnterHalfOpenLocked() bool {
	if b.state != StateOpen {
		return b.state == StateHalfOpen
	}
	if b.clock.Now().Sub(b.openedAt) < b.openDuration {
		return false
	}
	b.transitionLocked(StateHalfOpen)
	return true
}

func (b *Breaker) transitionLocked(s State) {
	b.state = s
	b.generation++
	switch s {
	case StateOpen:
		b.openedAt = b.clock.Now()
		b.consecutiveFailures = 0
		b.probesInFlight = 0
		b.probeSuccesses = 0
	case StateHalfOpen:
		b.probesInFlight = 0
		b.probeSuccesses = 0
	case StateClosed:
		b.consecutiveFailures = 0
		b.probesInFlight = 0
		b.probeSuccesses = 0
	}
}
