// Package leasequota implements disk-quota accounting for file downloads.
//
// A Quota splits its total byte budget into "used" bytes (committed files)
// and "reserved" bytes (outstanding leases held by in-flight downloads).
// The invariant used+reserved <= total holds at all times. A download
// reserves quota through a Lease; on commit exactly the bytes actually
// written become used and the rest of the reservation is returned, and on
// cancel or commit failure the whole reservation is returned.
package leasequota

import (
	"errors"
	"fmt"
	"sync"
)

// ErrQuotaExceeded is returned when a reservation or lease growth would
// exceed the total quota.
var ErrQuotaExceeded = errors.New("leasequota: disk quota exceeded")

// Quota tracks committed (used) and reserved bytes against a total budget.
// It is safe for concurrent use.
type Quota struct {
	mu       sync.Mutex
	total    int64
	used     int64
	reserved int64
}

// NewQuota returns a Quota allowing total bytes of used+reserved data.
func NewQuota(total int64) *Quota {
	if total < 0 {
		panic("leasequota: negative total quota")
	}
	return &Quota{total: total}
}

// Snapshot returns a consistent view of the quota counters.
func (q *Quota) Snapshot() (used, reserved, total int64) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.used, q.reserved, q.total
}

// Used reports bytes held by committed files.
func (q *Quota) Used() int64 {
	used, _, _ := q.Snapshot()
	return used
}

// Reserved reports bytes held by outstanding leases.
func (q *Quota) Reserved() int64 {
	_, reserved, _ := q.Snapshot()
	return reserved
}

// Total reports the quota budget.
func (q *Quota) Total() int64 {
	_, _, total := q.Snapshot()
	return total
}

// Available reports bytes that can still be reserved: total-used-reserved.
func (q *Quota) Available() int64 {
	used, reserved, total := q.Snapshot()
	return total - used - reserved
}

// Reserve takes out a lease for n bytes. It fails with ErrQuotaExceeded if
// fewer than n bytes are available.
func (q *Quota) Reserve(n int64) (*Lease, error) {
	if n < 0 {
		return nil, fmt.Errorf("leasequota: cannot reserve a negative amount: %d", n)
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if n > q.total-q.used-q.reserved {
		return nil, fmt.Errorf("%w: requested %d bytes, %d available", ErrQuotaExceeded, n, q.total-q.used-q.reserved)
	}
	q.reserved += n
	return &Lease{quota: q, outstanding: n}, nil
}

// Free returns n bytes of used quota, e.g. after a committed file is deleted.
func (q *Quota) Free(n int64) error {
	if n < 0 {
		return fmt.Errorf("leasequota: cannot free a negative amount: %d", n)
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if n > q.used {
		return fmt.Errorf("leasequota: cannot free %d bytes, only %d in use", n, q.used)
	}
	q.used -= n
	return nil
}

// Lease is a reservation of quota bytes held by one in-flight download.
//
// A lease is closed by exactly one of Commit or Release; any further use
// returns an error. In particular a committed lease cannot be cancelled.
type Lease struct {
	mu          sync.Mutex
	quota       *Quota
	outstanding int64
	closed      bool
}

// Outstanding reports the reserved bytes not yet committed or released.
func (l *Lease) Outstanding() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.outstanding
}

// Grow extends the lease by n bytes, e.g. when the source delivers more data
// than the length it declared. It fails with ErrQuotaExceeded if the quota
// cannot cover the extension; the lease then keeps its previous size.
func (l *Lease) Grow(n int64) error {
	if n < 0 {
		return fmt.Errorf("leasequota: cannot grow by a negative amount: %d", n)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return errors.New("leasequota: lease is closed")
	}
	l.quota.mu.Lock()
	defer l.quota.mu.Unlock()
	if n > l.quota.total-l.quota.used-l.quota.reserved {
		return fmt.Errorf("%w: cannot grow lease by %d bytes, %d available", ErrQuotaExceeded, n, l.quota.total-l.quota.used-l.quota.reserved)
	}
	l.quota.reserved += n
	l.outstanding += n
	return nil
}

// Commit converts n actually-written bytes into used quota and releases the
// remaining reservation. n must not exceed the outstanding reservation.
// The lease is closed and can no longer be released (cancelled).
func (l *Lease) Commit(n int64) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return errors.New("leasequota: lease is closed")
	}
	if n < 0 || n > l.outstanding {
		return fmt.Errorf("leasequota: cannot commit %d bytes with %d outstanding", n, l.outstanding)
	}
	l.quota.mu.Lock()
	l.quota.reserved -= l.outstanding
	l.quota.used += n
	l.quota.mu.Unlock()
	l.outstanding = 0
	l.closed = true
	return nil
}

// Release cancels the lease, returning all outstanding reserved bytes.
func (l *Lease) Release() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return errors.New("leasequota: lease is closed")
	}
	l.quota.mu.Lock()
	l.quota.reserved -= l.outstanding
	l.quota.mu.Unlock()
	l.outstanding = 0
	l.closed = true
	return nil
}
