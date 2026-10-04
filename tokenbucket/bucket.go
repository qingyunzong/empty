// Package tokenbucket implements a persistent token bucket rate limiter
// driven by explicit monotonic logical time.
//
// Semantics:
//   - Time is supplied by the caller as an int64 logical clock. The bucket
//     never reads the wall clock. Time moving backwards (or standing still)
//     never adds tokens: accrual only happens for now > last.
//   - The refill rate is the rational RateNum/RateDen tokens per tick.
//     Fractional accrual is accumulated in an integer remainder, so no
//     tokens are lost or invented across refills.
//   - Allow is idempotent per request ID within a bounded window: a repeated
//     ID returns the original decision and is never charged twice, even
//     across restarts, as long as the ID is still inside the idempotency
//     window retained by the log.
//   - State is persisted to an append-only log. Truncate compacts the log
//     into a snapshot plus the current idempotency window.
package tokenbucket

// bucket is the pure in-memory state of the token bucket.
type bucket struct {
	capacity int64
	rateNum  int64
	rateDen  int64

	tokens  int64
	rem     int64 // 0 <= rem < rateDen; fractional accrual is tokens + rem/rateDen
	last    int64 // last logical time seen
	hasTime bool  // whether last has been initialized
}

func newBucket(capacity, rateNum, rateDen int64) bucket {
	return bucket{
		capacity: capacity,
		rateNum:  rateNum,
		rateDen:  rateDen,
		tokens:   capacity, // buckets start full
	}
}

// refill accrues tokens up to logical time now. It is monotone: if now does
// not advance past the last seen time, nothing is accrued.
func (b *bucket) refill(now int64) {
	if !b.hasTime {
		b.last = now
		b.hasTime = true
		return
	}
	if now <= b.last {
		return
	}
	dt := now - b.last
	b.last = now
	total := dt*b.rateNum + b.rem
	add := total / b.rateDen
	b.rem = total % b.rateDen
	b.tokens += add
	if b.tokens >= b.capacity {
		b.tokens = b.capacity
		b.rem = 0 // clamped: accrual beyond capacity is discarded
	}
}

// tryTake attempts to spend cost tokens, refilling up to now first.
func (b *bucket) tryTake(cost int64, now int64) bool {
	b.refill(now)
	if cost > b.tokens {
		return false
	}
	b.tokens -= cost
	return true
}
