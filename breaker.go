package formal

import (
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

type permitOwner interface {
	finishPermit(*Permit, time.Time, Result)
	cancelPermit(*Permit)
}

// Permit is one admitted call. Finish or Cancel must be called exactly once;
// additional calls are ignored.
type Permit struct {
	done               atomic.Bool
	clock              Clock
	owner              permitOwner
	instance           *breakerState
	started            time.Time
	generation         uint64
	instanceGeneration uint64
	sharedProbe        bool
}

// Success records a non-failed call using the elapsed time from the clock.
func (p *Permit) Success() {
	p.Done(false)
}

// Failure records a failed call using the elapsed time from the clock.
func (p *Permit) Failure() {
	p.Done(true)
}

// Done records a call whose latency is measured from permit acquisition.
func (p *Permit) Done(failed bool) {
	latency := p.clock.Now().Sub(p.started)
	p.DoneWithLatency(failed, latency)
}

// DoneWithLatency records a call with an explicit latency.
func (p *Permit) DoneWithLatency(failed bool, latency time.Duration) {
	if latency < 0 {
		latency = 0
	}
	p.finish(Result{Failed: failed, Latency: latency})
}

// Finish is a convenience method for ordinary error-returning calls.
func (p *Permit) Finish(err error) {
	p.Done(err != nil)
}

// Cancel releases probe capacity without recording a result. It is useful when
// a caller abandons a request before an upstream response is known.
func (p *Permit) Cancel() {
	if !p.done.CompareAndSwap(false, true) {
		return
	}
	p.owner.cancelPermit(p)
}

func (p *Permit) finish(result Result) {
	if !p.done.CompareAndSwap(false, true) {
		return
	}
	p.owner.finishPermit(p, p.clock.Now(), result)
}

// Breaker is a standalone circuit breaker for callers that only need one
// statistical layer. Group provides route and instance layers.
type Breaker struct {
	mu    sync.Mutex
	clock Clock
	state breakerState
}

// NewBreaker creates a standalone breaker with the real clock.
func NewBreaker(policy Policy) (*Breaker, error) {
	return NewBreakerWithClock(policy, RealClock{})
}

// NewBreakerWithClock creates a standalone breaker with an injected clock.
func NewBreakerWithClock(policy Policy, clock Clock) (*Breaker, error) {
	if err := policy.validate("breaker"); err != nil {
		return nil, err
	}
	if clock == nil {
		return nil, errors.New("formal: clock must not be nil")
	}
	return &Breaker{
		clock: clock,
		state: newBreakerState(policy),
	}, nil
}

// Acquire admits a call or rejects it when the breaker is open or its
// half-open probe capacity is exhausted.
func (b *Breaker) Acquire() (*Permit, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	now := b.clock.Now()
	b.state.advance(now)
	if b.state.state == StateOpen || !b.state.probeCapacityAvailable() {
		return nil, ErrOpen
	}
	b.state.startProbe()
	return &Permit{
		clock:      b.clock,
		owner:      b,
		started:    now,
		generation: b.state.generation,
	}, nil
}

// State returns the current state, advancing an expired open interval.
func (b *Breaker) State() State {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.state.advance(b.clock.Now())
	return b.state.state
}

// Snapshot returns the current window and state.
func (b *Breaker) Snapshot() Snapshot {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.state.snapshot(b.clock.Now())
}

func (b *Breaker) finishPermit(permit *Permit, now time.Time, result Result) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.state.finish(now, permit.generation, result)
}

func (b *Breaker) cancelPermit(permit *Permit) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.state.cancelProbe(permit.generation)
}
