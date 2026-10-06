// Package circuitbreaker implements a three-state (closed/open/half-open)
// circuit breaker with generation-scoped probes.
package circuitbreaker

import (
	"errors"
	"sync"
	"time"
)

// State is the breaker state: closed (正常), open (开启/熔断), half-open (半开).
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
	return "unknown"
}

var (
	// ErrOpen is returned to normal requests while the breaker is open.
	ErrOpen = errors.New("circuitbreaker: breaker is open")
	// ErrTooManyProbes is returned when half-open already has K probes in flight.
	ErrTooManyProbes = errors.New("circuitbreaker: half-open probe limit reached")
)

// Breaker is a three-state circuit breaker.
//
// Closed: requests flow; consecutive failures >= failureThreshold trip it open.
// Open: requests are rejected with ErrOpen until openDuration elapses
// (measured on the injected Clock), then it becomes half-open.
// Half-open: at most maxProbes (K) concurrent probes; a probe success closes
// the breaker, a probe failure re-opens it.
//
// Every Allow returns a generation token. Results (Success/Failure) only
// affect the breaker if they carry the current generation: a late success
// from an older generation can never close a newly opened generation.
type Breaker struct {
	clock            Clock
	failureThreshold int
	openDuration     time.Duration
	maxProbes        int

	mu                  sync.Mutex
	state               State
	generation          uint64
	consecutiveFailures int
	openedAt            time.Time
	activeProbes        int
}

// New builds a Breaker. If clock is nil, a real wall clock is used.
func New(failureThreshold int, openDuration time.Duration, maxProbes int, clock Clock) *Breaker {
	if failureThreshold < 1 {
		failureThreshold = 1
	}
	if maxProbes < 1 {
		maxProbes = 1
	}
	if clock == nil {
		clock = realClock{}
	}
	return &Breaker{
		clock:            clock,
		failureThreshold: failureThreshold,
		openDuration:     openDuration,
		maxProbes:        maxProbes,
		state:            StateClosed,
	}
}

// State reports the current state, applying any pending time-based transition.
func (b *Breaker) State() State {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.maybeHalfOpenLocked(b.clock.Now())
	return b.state
}

// Generation reports the current generation (for tests/diagnostics).
func (b *Breaker) Generation() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.generation
}

// Allow admits or rejects a request. On success it returns the generation
// token that must be passed back to Success/Failure.
func (b *Breaker) Allow() (uint64, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.maybeHalfOpenLocked(b.clock.Now())
	switch b.state {
	case StateClosed:
		return b.generation, nil
	case StateHalfOpen:
		if b.activeProbes >= b.maxProbes {
			return 0, ErrTooManyProbes
		}
		b.activeProbes++
		return b.generation, nil
	default: // StateOpen
		return 0, ErrOpen
	}
}

// Success records a successful request for the given generation.
// Stale-generation results are ignored.
func (b *Breaker) Success(generation uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if generation != b.generation {
		return
	}
	switch b.state {
	case StateClosed:
		b.consecutiveFailures = 0
	case StateHalfOpen:
		b.activeProbes--
		b.closeLocked()
	}
}

// Failure records a failed request for the given generation.
// Stale-generation results are ignored.
func (b *Breaker) Failure(generation uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if generation != b.generation {
		return
	}
	switch b.state {
	case StateClosed:
		b.consecutiveFailures++
		if b.consecutiveFailures >= b.failureThreshold {
			b.openLocked(b.clock.Now())
		}
	case StateHalfOpen:
		b.activeProbes--
		b.openLocked(b.clock.Now())
	}
}

// Execute runs fn under breaker protection and records its outcome.
func (b *Breaker) Execute(fn func() error) error {
	generation, err := b.Allow()
	if err != nil {
		return err
	}
	err = fn()
	if err != nil {
		b.Failure(generation)
	} else {
		b.Success(generation)
	}
	return err
}

// maybeHalfOpenLocked moves open -> half-open once openDuration has elapsed.
func (b *Breaker) maybeHalfOpenLocked(now time.Time) {
	if b.state == StateOpen && !now.Before(b.openedAt.Add(b.openDuration)) {
		b.state = StateHalfOpen
		b.generation++
		b.activeProbes = 0
	}
}

func (b *Breaker) openLocked(now time.Time) {
	b.state = StateOpen
	b.generation++
	b.consecutiveFailures = 0
	b.openedAt = now
}

func (b *Breaker) closeLocked() {
	b.state = StateClosed
	b.generation++
	b.consecutiveFailures = 0
	b.activeProbes = 0
}
