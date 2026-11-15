package dataeng

import (
	"math"
	"time"
)

// BucketConfig describes a token bucket.
//
// Rate is the number of tokens added per second. A zero rate disables
// refilling. Burst is the bucket capacity and the initial number of tokens.
// A zero Burst means the bucket is unlimited. An unlimited bucket ignores
// Rate, which makes the zero value useful for unconstrained scopes.
type BucketConfig struct {
	Rate  float64
	Burst float64
}

const neverDuration = time.Duration(math.MaxInt64)

type tokenBucket struct {
	rate       float64
	baseRate   float64
	burst      float64
	tokens     float64
	last       time.Time
	configured bool

	// windowEnd is set when a quota header lets us estimate a window
	// refill rate. At the end of the window the configured rate resumes.
	windowEnd time.Time
}

type limitState struct {
	bucket        tokenBucket
	inFlight      float64
	cooldownUntil time.Time
}

func validateBucketConfig(cfg BucketConfig) error {
	if math.IsNaN(cfg.Rate) || cfg.Rate < 0 {
		return errInvalidBucketRate
	}
	if math.IsNaN(cfg.Burst) || cfg.Burst < 0 {
		return errInvalidBucketBurst
	}
	return nil
}

func newLimitState(cfg BucketConfig, now time.Time) limitState {
	return limitState{bucket: newTokenBucket(cfg, now)}
}

func newTokenBucket(cfg BucketConfig, now time.Time) tokenBucket {
	if cfg.Burst == 0 {
		return tokenBucket{
			rate:       math.Inf(1),
			baseRate:   math.Inf(1),
			burst:      math.Inf(1),
			tokens:     math.Inf(1),
			last:       now,
			configured: false,
		}
	}
	rate := cfg.Rate
	return tokenBucket{
		rate:       rate,
		baseRate:   rate,
		burst:      cfg.Burst,
		tokens:     cfg.Burst,
		last:       now,
		configured: true,
	}
}

func (b *tokenBucket) refill(now time.Time) {
	if !b.windowEnd.IsZero() && !now.Before(b.windowEnd) {
		if b.windowEnd.After(b.last) {
			b.tokens = math.Min(b.burst, b.tokens+b.rate*b.windowEnd.Sub(b.last).Seconds())
			b.last = b.windowEnd
		}
		b.rate = b.baseRate
		b.windowEnd = time.Time{}
	}
	if !now.After(b.last) {
		return
	}
	elapsed := now.Sub(b.last).Seconds()
	b.last = now
	if b.tokens >= b.burst || b.rate <= 0 {
		return
	}
	if math.IsInf(b.rate, 1) {
		b.tokens = b.burst
		return
	}
	b.tokens = math.Min(b.burst, b.tokens+b.rate*elapsed)
}

func (b *tokenBucket) take(now time.Time, amount float64) bool {
	b.refill(now)
	if b.tokens < amount {
		return false
	}
	b.tokens -= amount
	return true
}

func (b *tokenBucket) restore(now time.Time, amount float64) {
	b.refill(now)
	b.tokens = math.Min(b.burst, b.tokens+amount)
}

// timeUntil returns how long it takes before amount tokens are available.
// neverDuration means the bucket can never satisfy the request.
func (b *tokenBucket) timeUntil(now time.Time, amount float64) time.Duration {
	b.refill(now)
	if b.tokens >= amount {
		return 0
	}
	if amount > b.burst || b.rate <= 0 {
		return neverDuration
	}
	if math.IsInf(b.rate, 1) {
		return neverDuration
	}
	seconds := (amount - b.tokens) / b.rate
	if seconds < 0 || math.IsInf(seconds, 0) || math.IsNaN(seconds) {
		return neverDuration
	}
	nanos := math.Ceil(seconds * float64(time.Second))
	if nanos >= float64(neverDuration) {
		return neverDuration
	}
	d := time.Duration(nanos) + time.Nanosecond
	if d <= 0 {
		d = time.Nanosecond
	}
	return d
}

func (l *limitState) cooldownWait(now time.Time) time.Duration {
	if !l.cooldownUntil.After(now) {
		return 0
	}
	return l.cooldownUntil.Sub(now)
}

func (l *limitState) extendCooldown(until time.Time) {
	if until.After(l.cooldownUntil) {
		l.cooldownUntil = until
	}
}

func (l *limitState) applyQuota(q QuotaState, at time.Time) {
	b := &l.bucket
	b.refill(at)
	dynamicOnly := !b.configured
	if dynamicOnly && (q.Limit != nil || q.Remaining != nil) {
		b.configured = true
		b.rate = 0
		b.baseRate = 0
	}

	if q.Limit != nil {
		b.burst = *q.Limit
		if b.tokens > b.burst {
			b.tokens = b.burst
		}
	}
	if q.Remaining != nil {
		remaining := *q.Remaining
		if remaining > b.burst {
			remaining = b.burst
		}
		if l.inFlight == 0 || remaining < b.tokens {
			b.tokens = remaining
		}
	}
	if q.ResetAt != nil && !q.ResetAt.IsZero() && q.ResetAt.After(at) {
		window := q.ResetAt.Sub(at).Seconds()
		if window > 0 && b.burst < math.Inf(1) {
			if b.tokens < b.burst {
				b.rate = (b.burst - b.tokens) / window
			} else {
				b.rate = 0
			}
			if dynamicOnly {
				b.baseRate = b.rate
			}
			b.windowEnd = *q.ResetAt
		}
	}
	if q.RetryAfter != nil {
		l.extendCooldown(at.Add(*q.RetryAfter))
	}
}
