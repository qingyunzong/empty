// Package refund implements a collection ledger that allocates refunds back
// to the original paying accounts in proportion to their payments.
//
// Allocation rule (cumulative, deterministic):
//   - For a cumulative refunded amount R over an original total T, each
//     account's cumulative share is floor(R * paid_i / T).
//   - The remaining cents (R minus the sum of floored shares) are distributed
//     one cent per account in ascending account-ID order.
//   - Every refund request only tops up the per-account delta between the new
//     and the previous cumulative allocation.
//
// Safety rules:
//   - A repeated request ID with a different amount is rejected; the same
//     amount is an idempotent no-op.
//   - The cumulative refunded total never exceeds the original payment total.
package refund

import (
	"errors"
	"fmt"
	"sort"
)

var (
	// ErrDuplicateRequest is returned when a request ID is reused with a
	// different amount than originally recorded.
	ErrDuplicateRequest = errors.New("refund: duplicate request id with different amount")
	// ErrExceedsTotal is returned when a refund would push the cumulative
	// refunded total above the original payment total.
	ErrExceedsTotal = errors.New("refund: cumulative refund exceeds original payment")
	// ErrInvalidAmount is returned for negative refund amounts.
	ErrInvalidAmount = errors.New("refund: amount must be non-negative")
)

// Account is one original payer: ID identifies the account and Paid is the
// amount (in cents) it contributed to the original payment.
type Account struct {
	ID   string
	Paid int64
}

// Ledger tracks the original payment split and the cumulative refund state.
type Ledger struct {
	accounts      []Account // sorted by ID
	total         int64
	cumulative    map[string]int64 // cumulative refunded share per account
	requests      map[string]int64 // request ID -> amount
	totalRefunded int64
}

// NewLedger builds a ledger from the original payment split. Account IDs must
// be unique and non-empty, and each paid amount must be positive.
func NewLedger(accounts []Account) (*Ledger, error) {
	if len(accounts) == 0 {
		return nil, errors.New("refund: at least one account required")
	}
	seen := make(map[string]bool, len(accounts))
	var total int64
	for _, a := range accounts {
		if a.ID == "" {
			return nil, errors.New("refund: account id must not be empty")
		}
		if a.Paid <= 0 {
			return nil, fmt.Errorf("refund: account %q paid amount must be positive", a.ID)
		}
		if seen[a.ID] {
			return nil, fmt.Errorf("refund: duplicate account id %q", a.ID)
		}
		seen[a.ID] = true
		total += a.Paid
	}
	sorted := make([]Account, len(accounts))
	copy(sorted, accounts)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].ID < sorted[j].ID })
	return &Ledger{
		accounts:   sorted,
		total:      total,
		cumulative: make(map[string]int64, len(sorted)),
		requests:   make(map[string]int64),
	}, nil
}

// Allocate computes the cumulative per-account refund shares for a cumulative
// refunded amount: proportional floor shares plus remainder cents assigned in
// ascending account-ID order. It is pure and does not mutate the ledger.
func (l *Ledger) Allocate(cumAmount int64) map[string]int64 {
	shares := make(map[string]int64, len(l.accounts))
	var assigned int64
	for _, a := range l.accounts {
		share := cumAmount * a.Paid / l.total
		shares[a.ID] = share
		assigned += share
	}
	for i := int64(0); i < cumAmount-assigned; i++ {
		shares[l.accounts[i].ID]++
	}
	return shares
}

// Refund applies one refund request of the given (incremental) amount and
// returns the per-account delta to pay out in this request (accounts with a
// zero delta are omitted).
//
// Replaying an already-seen request ID with the same amount is an idempotent
// no-op returning an empty delta; replaying it with a different amount fails
// with ErrDuplicateRequest. The refund fails with ErrExceedsTotal if it would
// push the cumulative refunded total above the original payment total.
func (l *Ledger) Refund(requestID string, amount int64) (map[string]int64, error) {
	if amount < 0 {
		return nil, ErrInvalidAmount
	}
	if prev, ok := l.requests[requestID]; ok {
		if prev != amount {
			return nil, fmt.Errorf("%w: id %q recorded %d, got %d", ErrDuplicateRequest, requestID, prev, amount)
		}
		return map[string]int64{}, nil
	}
	if l.totalRefunded+amount > l.total {
		return nil, fmt.Errorf("%w: %d + %d > %d", ErrExceedsTotal, l.totalRefunded, amount, l.total)
	}
	next := l.Allocate(l.totalRefunded + amount)
	delta := make(map[string]int64, len(l.accounts))
	for id, share := range next {
		if d := share - l.cumulative[id]; d != 0 {
			delta[id] = d
		}
	}
	l.cumulative = next
	l.totalRefunded += amount
	l.requests[requestID] = amount
	return delta, nil
}

// Total returns the original payment total.
func (l *Ledger) Total() int64 { return l.total }

// TotalRefunded returns the cumulative refunded amount so far.
func (l *Ledger) TotalRefunded() int64 { return l.totalRefunded }

// Refunded returns the cumulative refunded share of one account.
func (l *Ledger) Refunded(accountID string) int64 { return l.cumulative[accountID] }
