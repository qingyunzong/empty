// Package ratelimit implements a token-bucket rate limiter that accepts
// reservations of integer token costs for future ticks.
//
// Semantics:
//   - Time is measured in integer ticks supplied by a Clock (a virtual
//     clock, e.g. ManualClock, is used in tests).
//   - The bucket refills at an exact rational rate of rateNum/rateDen
//     tokens per tick. The fractional remainder is carried exactly; no
//     token is ever rounded away. Balance is capped at the bucket
//     capacity; tokens refilled beyond the cap are discarded.
//   - Reserve schedules a new reservation at the earliest feasible tick
//     that is >= max(now, notBefore) and not earlier than any already
//     pending reservation (append semantics). Reservations that share a
//     tick consume tokens in reservation (sequence) order.
//   - Cancel removes a pending reservation, refunds its cost, and
//     re-packs the remaining pending reservations to their earliest
//     feasible ticks. Re-packing never moves a reservation before the
//     current tick, so it can never cross an already executed
//     reservation (executed reservations always have tick <= now).
//   - Tokens are deducted from the bucket when a reservation executes,
//     not when it is reserved.
package ratelimit

import (
	"fmt"
	"sync"
)

// Clock reports the current time in ticks.
type Clock interface {
	Now() int64
}

// ManualClock is a virtual Clock controlled by the caller.
type ManualClock struct {
	mu  sync.Mutex
	now int64
}

// NewManualClock returns a ManualClock positioned at start.
func NewManualClock(start int64) *ManualClock {
	return &ManualClock{now: start}
}

// Now returns the current tick.
func (c *ManualClock) Now() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// Advance moves the clock forward by d ticks. It panics if d < 0.
func (c *ManualClock) Advance(d int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if d < 0 {
		panic("ratelimit: cannot advance clock by a negative amount")
	}
	c.now += d
}

// Status describes the lifecycle state of a Reservation.
type Status int

const (
	Pending Status = iota
	Executed
	Canceled
)

func (s Status) String() string {
	switch s {
	case Pending:
		return "Pending"
	case Executed:
		return "Executed"
	case Canceled:
		return "Canceled"
	}
	return "Unknown"
}

// Reservation is a claim on cost tokens at a future tick.
type Reservation struct {
	// Seq is the reservation order; ties on the same tick are broken by Seq.
	Seq int64
	// Cost is the integer number of tokens claimed.
	Cost int64
	// NotBefore is the earliest tick the reservation may execute.
	NotBefore int64
	// At is the currently scheduled tick. It may move earlier when a
	// preceding reservation is canceled, but never before the current
	// tick and never past an executed reservation.
	At int64

	status Status
}

// Status reports the reservation lifecycle state. It is only meaningful
// while the caller holds no expectation of concurrent mutation; use
// Limiter.Status for a race-safe read.
func (r *Reservation) Status() Status { return r.status }

// Limiter is a token bucket with future reservations. It is safe for
// concurrent use.
type Limiter struct {
	mu    sync.Mutex
	clock Clock

	cap int64 // bucket capacity, in whole tokens
	rn  int64 // refill rate numerator (tokens per tick = rn/rd)
	rd  int64 // refill rate denominator

	bal  int64 // current balance in 1/rd token units
	last int64 // tick at which bal was last updated

	seq     int64          // reservation sequence counter
	pending []*Reservation // pending reservations, Seq order; At is non-decreasing
}

// NewLimiter returns a Limiter with the given token capacity (in whole
// tokens) and a refill rate of rateNum/rateDen tokens per tick. The
// bucket starts full. It panics on invalid parameters.
func NewLimiter(capacity, rateNum, rateDen int64, clock Clock) *Limiter {
	if capacity <= 0 {
		panic("ratelimit: capacity must be positive")
	}
	if rateNum < 0 || rateDen <= 0 {
		panic("ratelimit: rate must be non-negative with a positive denominator")
	}
	if clock == nil {
		panic("ratelimit: clock must not be nil")
	}
	l := &Limiter{
		clock: clock,
		cap:   capacity,
		rn:    rateNum,
		rd:    rateDen,
		last:  clock.Now(),
	}
	l.bal = capacity * rateDen // start full
	return l
}

// Capacity returns the bucket capacity in whole tokens.
func (l *Limiter) Capacity() int64 { return l.cap }

// ceilDiv returns ceil(a/b) for a >= 0, b > 0.
func ceilDiv(a, b int64) int64 {
	return (a + b - 1) / b
}

// sync advances the bucket state to tick now, executing every pending
// reservation scheduled at or before now in (At, Seq) order, and returns
// the reservations executed by this call. Caller must hold l.mu.
func (l *Limiter) sync(now int64) []Reservation {
	var executed []Reservation
	for len(l.pending) > 0 && l.pending[0].At <= now {
		r := l.pending[0]
		l.pending = l.pending[1:]
		l.bal = min(l.cap*l.rd, l.bal+l.rn*(r.At-l.last))
		l.last = r.At
		l.bal -= r.Cost * l.rd // guaranteed >= 0 by the scheduling invariant
		r.status = Executed
		executed = append(executed, *r)
	}
	l.bal = min(l.cap*l.rd, l.bal+l.rn*(now-l.last))
	l.last = now
	return executed
}

// earliestTick returns the earliest tick >= lo at which need units
// (1/rd tokens) are available from balance bal at tick from. ok is false
// if the need can never be met (zero refill rate and insufficient
// balance).
func (l *Limiter) earliestTick(from, bal, need, lo int64) (tick int64, ok bool) {
	if bal >= need {
		return lo, true
	}
	if l.rn == 0 {
		return 0, false
	}
	t := from + ceilDiv(need-bal, l.rn)
	if t < lo {
		t = lo
	}
	return t, true
}

// Reserve claims cost tokens at the earliest feasible tick >=
// max(now, notBefore), after all currently pending reservations. It
// returns ok=false without changing anything if cost is not a positive
// integer affordable by the bucket (cost > capacity) or if the claim can
// never be satisfied (zero refill rate with insufficient tokens).
func (l *Limiter) Reserve(cost, notBefore int64) (r *Reservation, ok bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if cost <= 0 || cost > l.cap {
		return nil, false
	}
	now := l.clock.Now()
	l.sync(now)

	// Replay pending reservations to find the balance after the last one.
	bal, from := l.bal, l.last
	for _, p := range l.pending {
		bal = min(l.cap*l.rd, bal+l.rn*(p.At-from)) - p.Cost*l.rd
		from = p.At
	}
	lo := max(notBefore, now, from)
	at, ok := l.earliestTick(from, bal, cost*l.rd, lo)
	if !ok {
		return nil, false
	}
	l.seq++
	r = &Reservation{Seq: l.seq, Cost: cost, NotBefore: notBefore, At: at, status: Pending}
	l.pending = append(l.pending, r)
	return r, true
}

// Cancel removes a pending reservation, refunds its cost, and re-packs
// the remaining pending reservations to their earliest feasible ticks
// (in reservation order, none before the current tick, hence never past
// an executed reservation). It returns the refunded cost. ok is false if
// r is not a pending reservation of this limiter (already executed,
// already canceled, or foreign).
func (l *Limiter) Cancel(r *Reservation) (refund int64, ok bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if r == nil {
		return 0, false
	}
	now := l.clock.Now()
	l.sync(now)

	idx := -1
	for i, p := range l.pending {
		if p == r {
			idx = i
			break
		}
	}
	if idx < 0 {
		return 0, false
	}
	l.pending = append(l.pending[:idx], l.pending[idx+1:]...)
	r.status = Canceled
	refund = r.Cost

	// Re-pack all remaining pending reservations from the current state.
	bal, from := l.bal, l.last
	for _, p := range l.pending {
		lo := max(p.NotBefore, now, from)
		at, ok := l.earliestTick(from, bal, p.Cost*l.rd, lo)
		if !ok {
			// Cannot happen: the reservation was feasible before the
			// cancel freed tokens, so it remains feasible.
			panic(fmt.Sprintf("ratelimit: reservation %d became infeasible during re-pack", p.Seq))
		}
		p.At = at
		bal = min(l.cap*l.rd, bal+l.rn*(at-from)) - p.Cost*l.rd
		from = at
	}
	return refund, true
}

// Sync executes every reservation scheduled at or before the current
// tick and returns them in (At, Seq) execution order.
func (l *Limiter) Sync() []Reservation {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.sync(l.clock.Now())
}

// Balance returns the current token balance as whole tokens plus an
// exact fractional remainder of rem/rateDen tokens.
func (l *Limiter) Balance() (whole, rem int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sync(l.clock.Now())
	return l.bal / l.rd, l.bal % l.rd
}

// Pending returns a snapshot of the pending reservations in reservation
// order. At values are non-decreasing; equal ticks are ordered by Seq.
func (l *Limiter) Pending() []Reservation {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sync(l.clock.Now())
	out := make([]Reservation, len(l.pending))
	for i, p := range l.pending {
		out[i] = *p
	}
	return out
}

// Status reports the lifecycle state of r.
func (l *Limiter) Status(r *Reservation) Status {
	l.mu.Lock()
	defer l.mu.Unlock()
	return r.status
}
