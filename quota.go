// Package quotadl implements lease-based disk quota accounting for downloads.
//
// A download reserves quota through a Lease before writing any bytes.
// Short writes, cancellation and commit failures all return the reserved
// quota exactly. A successful commit converts the reservation into used
// quota, after which the lease can no longer be cancelled.
package quotadl

import (
	"errors"
	"fmt"
	"sync"
)

// ErrQuotaExceeded is returned when a reservation would push
// used+reserved beyond the total quota.
var ErrQuotaExceeded = errors.New("quotadl: quota exceeded")

// Quota tracks disk quota as used + reserved <= total.
type Quota struct {
	mu       sync.Mutex
	total    int64
	used     int64
	reserved int64
}

// NewQuota returns a Quota with the given total capacity in bytes.
func NewQuota(total int64) *Quota {
	if total < 0 {
		panic("quotadl: negative total quota")
	}
	return &Quota{total: total}
}

// Stats reports a consistent snapshot of the quota counters.
type Stats struct {
	Total    int64
	Used     int64
	Reserved int64
}

// Stats returns the current quota counters.
func (q *Quota) Stats() Stats {
	q.mu.Lock()
	defer q.mu.Unlock()
	return Stats{Total: q.total, Used: q.used, Reserved: q.reserved}
}

// Reserve attempts to reserve n bytes and returns a Lease on success.
func (q *Quota) Reserve(n int64) (*Lease, error) {
	if n < 0 {
		return nil, fmt.Errorf("quotadl: cannot reserve negative amount %d", n)
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.used+q.reserved+n > q.total {
		return nil, fmt.Errorf("%w: need %d, available %d", ErrQuotaExceeded, n, q.total-q.used-q.reserved)
	}
	q.reserved += n
	return &Lease{q: q, amount: n}, nil
}

// Free returns n bytes of used quota (e.g. after deleting a file).
func (q *Quota) Free(n int64) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if n > q.used {
		panic("quotadl: freeing more than used")
	}
	q.used -= n
}

type leaseState int

const (
	leaseReserved leaseState = iota
	leaseCommitted
	leaseReleased
)

// Lease represents reserved quota for one in-flight download.
type Lease struct {
	q      *Quota
	amount int64
	state  leaseState
}

// Amount returns the reserved byte count of the lease.
func (l *Lease) Amount() int64 { return l.amount }

// extend grows the reservation by n bytes, subject to the quota.
func (l *Lease) extend(n int64) error {
	l.q.mu.Lock()
	defer l.q.mu.Unlock()
	if l.state != leaseReserved {
		return fmt.Errorf("quotadl: lease already finalized")
	}
	if l.q.used+l.q.reserved+n > l.q.total {
		return fmt.Errorf("%w: need %d more, available %d", ErrQuotaExceeded, n, l.q.total-l.q.used-l.q.reserved)
	}
	l.q.reserved += n
	l.amount += n
	return nil
}

// Commit converts used bytes of the reservation into used quota and
// refunds the remainder. After Commit the lease can no longer be
// released. used must not exceed the reserved amount.
func (l *Lease) Commit(used int64) error {
	l.q.mu.Lock()
	defer l.q.mu.Unlock()
	if l.state != leaseReserved {
		return fmt.Errorf("quotadl: lease already finalized")
	}
	if used < 0 || used > l.amount {
		return fmt.Errorf("quotadl: commit of %d bytes out of range [0,%d]", used, l.amount)
	}
	l.q.reserved -= l.amount
	l.q.used += used
	l.state = leaseCommitted
	return nil
}

// Release returns the entire reservation. It is a no-op error after
// the lease has been committed: committed quota is used and cannot be
// cancelled.
func (l *Lease) Release() error {
	l.q.mu.Lock()
	defer l.q.mu.Unlock()
	switch l.state {
	case leaseReserved:
		l.q.reserved -= l.amount
		l.state = leaseReleased
		return nil
	case leaseCommitted:
		return fmt.Errorf("quotadl: lease already committed, cannot cancel")
	default:
		return fmt.Errorf("quotadl: lease already released")
	}
}
