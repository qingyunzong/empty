// Package ratelimit implements a token-bucket rate limiter that reserves
// integer token costs against future clock ticks.
//
// Tokens are refilled at an exact rational rate (num/den tokens per tick)
// so fractional remainders are carried without rounding loss. Reservations
// that cannot be served immediately are scheduled at the earliest future
// tick at which enough tokens will have accumulated. Cancelling an
// unexecuted reservation refunds its cost and re-times the reservations
// queued behind it, without ever moving anything ahead of an already
// executed reservation. Reservations falling on the same tick keep their
// original reservation order.
package ratelimit

import (
	"math/big"
	"sync"
)

// Limiter is a token-bucket rate limiter driven by a virtual Clock.
type Limiter struct {
	mu    sync.Mutex
	clock *Clock
	rate  *big.Rat // tokens refilled per tick, exact
	burst *big.Rat // maximum token balance

	base    state          // token state after every executed reservation
	pending []*Reservation // unexecuted, ordered by (tick, seq)
	seq     int64          // reservation sequence counter
}

// state is the token balance at a given tick.
type state struct {
	tick   int64
	tokens *big.Rat
}

// Reservation is a promise of cost tokens at a future tick.
type Reservation struct {
	lim  *Limiter
	seq  int64
	cost int64
	tick int64
}

// NewLimiter returns a Limiter refilling rateNum/rateDen tokens per tick
// (exactly, carrying fractional remainders) with the given burst capacity,
// starting with a full bucket. The clock must never run backwards.
func NewLimiter(rateNum, rateDen, burst int64, clock *Clock) *Limiter {
	if rateNum <= 0 || rateDen <= 0 {
		panic("ratelimit: rate must be positive")
	}
	if burst <= 0 {
		panic("ratelimit: burst must be positive")
	}
	if clock == nil {
		clock = NewClock(0)
	}
	return &Limiter{
		clock: clock,
		rate:  big.NewRat(rateNum, rateDen),
		burst: big.NewRat(burst, 1),
		base: state{
			tick:   clock.Now(),
			tokens: big.NewRat(burst, 1),
		},
	}
}

// Burst returns the burst capacity in tokens.
func (l *Limiter) Burst() int64 {
	return l.burst.Num().Int64()
}

// Reserve books cost tokens and returns a Reservation scheduled at the
// earliest tick at which the tokens will be available, behind any
// previously queued reservations. It returns nil if cost is not in
// (0, Burst()].
func (l *Limiter) Reserve(cost int64) *Reservation {
	l.mu.Lock()
	defer l.mu.Unlock()
	if cost <= 0 || l.burst.Cmp(big.NewRat(cost, 1)) < 0 {
		return nil
	}
	l.collapse(l.clock.Now())
	l.seq++
	r := &Reservation{lim: l, seq: l.seq, cost: cost}
	l.pending = append(l.pending, r)
	l.replay()
	return r
}

// Cancel cancels an unexecuted reservation, refunding its cost. The
// reservations queued behind it are re-timed (never later than before,
// never ahead of any executed reservation, ties on one tick broken by
// reservation order). It reports whether the reservation was still
// pending; cancelling an executed or already cancelled reservation
// returns false.
func (l *Limiter) Cancel(r *Reservation) bool {
	if r == nil || r.lim != l {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.collapse(l.clock.Now())
	for i, p := range l.pending {
		if p.seq == r.seq {
			l.pending = append(l.pending[:i], l.pending[i+1:]...)
			l.replay()
			return true
		}
	}
	return false
}

// Cancel cancels the reservation through its limiter.
func (r *Reservation) Cancel() bool {
	return r.lim.Cancel(r)
}

// Tick returns the tick at which the reservation is (currently)
// scheduled to execute. Cancelling earlier reservations can only move
// it earlier.
func (r *Reservation) Tick() int64 {
	r.lim.mu.Lock()
	defer r.lim.mu.Unlock()
	return r.tick
}

// Cost returns the reserved token cost.
func (r *Reservation) Cost() int64 {
	return r.cost
}

// Delay returns the number of ticks from now until the reservation
// executes, or zero if its tick has already been reached.
func (r *Reservation) Delay() int64 {
	r.lim.mu.Lock()
	defer r.lim.mu.Unlock()
	if d := r.tick - r.lim.clock.Now(); d > 0 {
		return d
	}
	return 0
}

// collapse folds every reservation whose tick has been reached into the
// executed base state and advances the base to now.
func (l *Limiter) collapse(now int64) {
	kept := l.pending[:0]
	for _, r := range l.pending {
		if r.tick <= now {
			l.advance(&l.base, r.tick)
			l.base.tokens.Sub(l.base.tokens, big.NewRat(r.cost, 1))
		} else {
			kept = append(kept, r)
		}
	}
	l.pending = kept
	l.advance(&l.base, now)
}

// replay recomputes the ticks of all pending reservations in
// (tick, seq) order starting from the executed base state. Because the
// schedule is a pure function of the base state and the queued costs,
// replaying an unchanged queue reproduces the published ticks exactly.
func (l *Limiter) replay() {
	s := state{tick: l.base.tick, tokens: new(big.Rat).Set(l.base.tokens)}
	for _, r := range l.pending {
		r.tick = l.schedule(&s, r.cost)
	}
}

// advance moves s forward to the given tick, refilling tokens at the
// exact rate and capping the balance at the burst size.
func (l *Limiter) advance(s *state, to int64) {
	if to <= s.tick {
		return
	}
	gain := new(big.Rat).Mul(l.rate, big.NewRat(to-s.tick, 1))
	s.tokens.Add(s.tokens, gain)
	if s.tokens.Cmp(l.burst) > 0 {
		s.tokens.Set(l.burst)
	}
	s.tick = to
}

// schedule consumes cost tokens at s.tick, waiting whole ticks while the
// balance is negative, and returns the tick at which the cost is covered.
// The balance reached after waiting is capped at the burst size, exactly
// as a per-tick refill would cap it.
func (l *Limiter) schedule(s *state, cost int64) int64 {
	if need := new(big.Rat).Sub(big.NewRat(cost, 1), s.tokens); need.Sign() > 0 {
		wait := ceilRat(new(big.Rat).Quo(need, l.rate))
		gain := new(big.Rat).Mul(l.rate, big.NewRat(wait, 1))
		s.tokens.Add(s.tokens, gain)
		if s.tokens.Cmp(l.burst) > 0 {
			s.tokens.Set(l.burst)
		}
		s.tick += wait
	}
	s.tokens.Sub(s.tokens, big.NewRat(cost, 1))
	return s.tick
}

// ceilRat returns the smallest integer >= x, which must be non-negative.
func ceilRat(x *big.Rat) int64 {
	q, rem := new(big.Int).QuoRem(x.Num(), x.Denom(), new(big.Int))
	if rem.Sign() != 0 {
		q.Add(q, big.NewInt(1))
	}
	return q.Int64()
}
