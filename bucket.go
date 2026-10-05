// Package tokenbucket implements a persistent token bucket rate limiter
// driven by an explicit monotonic logical clock.
//
// Time is supplied by the caller as an int64 tick counter. The clock is
// monotonic: moving it backwards never refills tokens and never rewinds
// the bucket's last-seen timestamp.
//
// Refill uses exact integer arithmetic: the fractional part of
// elapsed*RateNum/RateDen is carried as a remainder, so no tokens are
// lost or created across advances. The bucket is equivalent to a
// rational-number model whose token count is floored.
package tokenbucket

import (
	"errors"
	"fmt"
	"math"
)

// Config describes a token bucket.
//
// Tokens refill at RateNum/RateDen tokens per logical tick, up to
// Capacity. RateNum must be >= 0 and RateDen must be > 0.
type Config struct {
	Capacity int64
	RateNum  int64
	RateDen  int64
}

func (c Config) validate() error {
	if c.Capacity < 0 {
		return errors.New("tokenbucket: capacity must be >= 0")
	}
	if c.RateNum < 0 {
		return errors.New("tokenbucket: rate numerator must be >= 0")
	}
	if c.RateDen <= 0 {
		return errors.New("tokenbucket: rate denominator must be > 0")
	}
	return nil
}

// Bucket is the in-memory core of the rate limiter. It is not safe for
// concurrent use; Store adds synchronization and persistence.
type Bucket struct {
	cfg    Config
	tokens int64 // whole tokens available
	rem    int64 // fractional refill numerator, in [0, RateDen)
	last   int64 // last logical time seen (monotonic)
}

// NewBucket returns a full bucket at logical time 0.
func NewBucket(cfg Config) (*Bucket, error) {
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &Bucket{cfg: cfg, tokens: cfg.Capacity}, nil
}

// refill advances the bucket to logical time now. A now earlier than the
// last seen time is clamped: no tokens are added and the clock does not
// move backwards.
func (b *Bucket) refill(now int64) {
	if now <= b.last {
		return
	}
	elapsed := now - b.last
	b.last = now
	if b.cfg.RateNum == 0 {
		return
	}
	if elapsed > (math.MaxInt64-b.rem)/b.cfg.RateNum {
		// Refill far exceeds any representable capacity; saturate.
		b.tokens = b.cfg.Capacity
		b.rem = 0
		return
	}
	total := b.rem + elapsed*b.cfg.RateNum
	add := total / b.cfg.RateDen
	rem := total % b.cfg.RateDen
	b.tokens += add
	b.rem = rem
	if b.tokens >= b.cfg.Capacity {
		// Capping discards the fractional part: the rational model
		// clamps to exactly Capacity, whose fraction is zero.
		b.tokens = b.cfg.Capacity
		b.rem = 0
	}
}

// Allow reports whether cost tokens are available at logical time now,
// consuming them if so. Negative cost is rejected.
func (b *Bucket) Allow(now, cost int64) (bool, error) {
	if cost < 0 {
		return false, errors.New("tokenbucket: cost must be >= 0")
	}
	b.refill(now)
	if b.tokens >= cost {
		b.tokens -= cost
		return true, nil
	}
	return false, nil
}

// State exposes the bucket internals for persistence and testing.
func (b *Bucket) State() (tokens, remainder, lastTime int64) {
	return b.tokens, b.rem, b.last
}

// restore sets the bucket internals from a persisted record.
func (b *Bucket) restore(tokens, remainder, lastTime int64) error {
	if tokens < 0 || tokens > b.cfg.Capacity {
		return fmt.Errorf("tokenbucket: corrupt state: tokens %d outside [0, %d]", tokens, b.cfg.Capacity)
	}
	if remainder < 0 || remainder >= b.cfg.RateDen {
		return fmt.Errorf("tokenbucket: corrupt state: remainder %d outside [0, %d)", remainder, b.cfg.RateDen)
	}
	b.tokens, b.rem, b.last = tokens, remainder, lastTime
	return nil
}
