package formal

import (
	"math"
	"time"
)

type tokenBucket struct {
	rate   float64
	burst  float64
	tokens float64
	last   time.Time
}

func newTokenBucket(limit RateLimit, now time.Time) tokenBucket {
	if !limit.enabled() {
		return tokenBucket{}
	}
	return tokenBucket{
		rate:   limit.Rate,
		burst:  float64(limit.Burst),
		tokens: float64(limit.Burst),
		last:   now,
	}
}

func (b *tokenBucket) enabled() bool {
	return b.rate > 0 && b.burst > 0
}

func (b *tokenBucket) refill(now time.Time) {
	if !b.enabled() {
		return
	}
	if now.After(b.last) {
		b.tokens += now.Sub(b.last).Seconds() * b.rate
		if b.tokens > b.burst {
			b.tokens = b.burst
		}
		b.last = now
	}
}

func (b *tokenBucket) ready(now time.Time) bool {
	if !b.enabled() {
		return true
	}
	b.refill(now)
	return b.tokens >= 1
}

func (b *tokenBucket) consume(now time.Time) bool {
	if !b.enabled() {
		return true
	}
	b.refill(now)
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (b *tokenBucket) wait(now time.Time) time.Duration {
	if !b.enabled() {
		return 0
	}
	b.refill(now)
	if b.tokens >= 1 {
		return 0
	}
	seconds := (1 - b.tokens) / b.rate
	if seconds <= 0 || math.IsNaN(seconds) {
		return 0
	}
	maxSeconds := float64(math.MaxInt64) / float64(time.Second)
	if math.IsInf(seconds, 0) || seconds >= maxSeconds {
		return time.Duration(math.MaxInt64)
	}
	wait := time.Duration(math.Ceil(seconds * float64(time.Second)))
	if wait < time.Nanosecond {
		wait = time.Nanosecond
	}
	return wait
}
