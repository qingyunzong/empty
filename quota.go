// Package quota implements a concurrency-safe quota ledger built on
// unsigned 64-bit counters.
//
// Semantics:
//   - All counters are uint64; increments that would overflow uint64 or
//     exceed a subject's limit, and refunds that would underflow below
//     zero, cause the entire batch to be rejected with no state change.
//   - A batch may touch multiple subjects; every operation is validated
//     against a scratch copy of the state first, and only committed once
//     the whole batch is known to be legal (validate-then-commit).
//   - Threshold comparisons are exact integer comparisons performed with
//     128-bit intermediate products; no floating-point conversion is used
//     anywhere in the package.
package quota

import (
	"errors"
	"fmt"
	"math/bits"
	"sync"
)

var (
	// ErrOverflow is returned when an increment would wrap the uint64
	// counter or push usage past the subject's limit.
	ErrOverflow = errors.New("quota: increment overflows counter or limit")
	// ErrUnderflow is returned when a refund exceeds the current usage.
	ErrUnderflow = errors.New("quota: refund exceeds current usage")
)

// Op is a single quota mutation within a batch.
type Op struct {
	Subject string
	Amount  uint64
	Refund  bool // false: charge (increment usage); true: refund (decrement usage)
}

// Limiter tracks per-subject usage against per-subject limits.
// The zero value is not ready for use; construct it with New.
type Limiter struct {
	mu     sync.Mutex
	used   map[string]uint64
	limits map[string]uint64
}

// New returns an empty Limiter.
func New() *Limiter {
	return &Limiter{
		used:   make(map[string]uint64),
		limits: make(map[string]uint64),
	}
}

// SetLimit sets the maximum usage allowed for a subject.
func (l *Limiter) SetLimit(subject string, limit uint64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.limits[subject] = limit
}

// Limit returns the limit configured for a subject.
func (l *Limiter) Limit(subject string) uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.limits[subject]
}

// Usage returns the current usage of a subject.
func (l *Limiter) Usage(subject string) uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.used[subject]
}

// Apply validates the whole batch and, only if every operation is legal,
// commits it atomically. On any overflow, limit breach, or underflow the
// entire batch is rejected and no counter changes.
func (l *Limiter) Apply(batch []Op) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	// Validate against a scratch view of only the touched subjects.
	scratch := make(map[string]uint64, len(batch))
	for i, op := range batch {
		cur, seen := scratch[op.Subject]
		if !seen {
			cur = l.used[op.Subject]
		}
		var next uint64
		if op.Refund {
			if op.Amount > cur {
				return fmt.Errorf("batch op %d (%s): %w", i, op.Subject, ErrUnderflow)
			}
			next = cur - op.Amount
		} else {
			sum, carry := bits.Add64(cur, op.Amount, 0)
			if carry != 0 || sum > l.limits[op.Subject] {
				return fmt.Errorf("batch op %d (%s): %w", i, op.Subject, ErrOverflow)
			}
			next = sum
		}
		scratch[op.Subject] = next
	}

	// Commit only after the full batch validated.
	for subject, next := range scratch {
		l.used[subject] = next
	}
	return nil
}

// cmpMul128 compares a*b with c*d using 128-bit exact arithmetic.
// It returns -1, 0, or +1. No floating-point conversion is involved.
func cmpMul128(a, b, c, d uint64) int {
	hiL, loL := bits.Mul64(a, b)
	hiR, loR := bits.Mul64(c, d)
	switch {
	case hiL < hiR:
		return -1
	case hiL > hiR:
		return +1
	case loL < loR:
		return -1
	case loL > loR:
		return +1
	default:
		return 0
	}
}

// UsageFractionAtLeast reports whether used/limit >= num/den, computed
// exactly via 128-bit cross-multiplication (used*den >= limit*num).
// It never converts to floating point, so it is exact even for values
// above 2^53 where float64 loses integer precision.
// den must be non-zero; limit == 0 is treated as "no headroom": the
// result is true only when num == 0.
func UsageFractionAtLeast(used, limit, num, den uint64) bool {
	if den == 0 {
		panic("quota: UsageFractionAtLeast with zero denominator")
	}
	return cmpMul128(used, den, limit, num) >= 0
}
