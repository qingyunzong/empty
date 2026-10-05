// Package quota provides a concurrency-safe quota ledger backed by
// unsigned 64-bit counters.
//
// Counters are uint64. Increments that would overflow and refunds that
// would underflow are rejected; a batch containing any invalid operation
// is rejected as a whole (validate first, then commit). Threshold
// comparisons are pure integer comparisons and never convert to float.
package quota

import (
	"errors"
	"fmt"
	"sync"
)

// Kind identifies the direction of an operation.
type Kind int

const (
	// Increment adds Amount to the subject's counter.
	Increment Kind = iota
	// Refund subtracts Amount from the subject's counter.
	Refund
)

// Op is a single quota operation against one subject.
type Op struct {
	Subject string
	Kind    Kind
	Amount  uint64
}

// ErrInvalidKind is returned when an Op carries an unknown Kind.
var ErrInvalidKind = errors.New("quota: invalid operation kind")

// OverflowError reports an increment that would exceed math.MaxUint64.
type OverflowError struct {
	Subject string
	Balance uint64
	Amount  uint64
}

func (e *OverflowError) Error() string {
	return fmt.Sprintf("quota: increment of %d overflows counter for %q (balance %d)", e.Amount, e.Subject, e.Balance)
}

// UnderflowError reports a refund larger than the current balance.
type UnderflowError struct {
	Subject string
	Balance uint64
	Amount  uint64
}

func (e *UnderflowError) Error() string {
	return fmt.Sprintf("quota: refund of %d underflows counter for %q (balance %d)", e.Amount, e.Subject, e.Balance)
}

// Ledger is a concurrency-safe set of uint64 quota counters keyed by subject.
type Ledger struct {
	mu       sync.Mutex
	balances map[string]uint64
}

// NewLedger returns an empty Ledger.
func NewLedger() *Ledger {
	return &Ledger{balances: make(map[string]uint64)}
}

// validate checks every op in the batch against the balances that would
// result from applying the preceding ops, without mutating the ledger.
// It returns the post-batch balance of each touched subject.
func validate(balances map[string]uint64, ops []Op) (map[string]uint64, error) {
	next := make(map[string]uint64, len(ops))
	get := func(subject string) uint64 {
		if v, ok := next[subject]; ok {
			return v
		}
		return balances[subject]
	}
	for i, op := range ops {
		cur := get(op.Subject)
		switch op.Kind {
		case Increment:
			if op.Amount > ^uint64(0)-cur {
				return nil, &OverflowError{Subject: op.Subject, Balance: cur, Amount: op.Amount}
			}
			next[op.Subject] = cur + op.Amount
		case Refund:
			if op.Amount > cur {
				return nil, &UnderflowError{Subject: op.Subject, Balance: cur, Amount: op.Amount}
			}
			next[op.Subject] = cur - op.Amount
		default:
			return nil, fmt.Errorf("%w: op %d for %q has kind %d", ErrInvalidKind, i, op.Subject, op.Kind)
		}
	}
	return next, nil
}

// Apply validates the whole batch and, only if every op is valid, commits
// all of them atomically. On any error the ledger is left untouched.
func (l *Ledger) Apply(ops []Op) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	next, err := validate(l.balances, ops)
	if err != nil {
		return err
	}
	for subject, balance := range next {
		l.balances[subject] = balance
	}
	return nil
}

// Balance returns the current counter for a subject.
func (l *Ledger) Balance(subject string) uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.balances[subject]
}

// CompareThreshold compares the subject's counter with threshold using
// pure integer comparison: it returns -1, 0 or +1 when the balance is
// below, equal to, or above the threshold. No floating-point conversion
// is involved, so values above 2^53 compare exactly.
func (l *Ledger) CompareThreshold(subject string, threshold uint64) int {
	b := l.Balance(subject)
	switch {
	case b < threshold:
		return -1
	case b > threshold:
		return 1
	default:
		return 0
	}
}

// AtLeast reports whether the subject's counter is >= threshold.
func (l *Ledger) AtLeast(subject string, threshold uint64) bool {
	return l.CompareThreshold(subject, threshold) >= 0
}
