// Package lease simulates single-machine lease grant, renewal, and
// authoritative switch with monotonically increasing fence numbers.
//
// Time is an explicit integer supplied by the caller. A lease with
// Expiry e is valid exactly on the half-open interval [Start, e):
// at t == e the lease is already expired (deadline is exclusive).
package lease

import "errors"

// Time is an explicit logical clock value in integer ticks.
type Time int64

var (
	ErrNotHolder     = errors.New("lease: caller is not the current holder")
	ErrExpired       = errors.New("lease: lease expired at this time")
	ErrStaleFence    = errors.New("lease: stale fence number")
	ErrUnknownHolder = errors.New("lease: no lease has been granted")
)

// Lease is a time-bounded, fenced grant of authority to a Holder.
type Lease struct {
	Holder string
	Fence  uint64
	Start  Time
	Expiry Time // exclusive: valid iff Start <= t && t < Expiry
}

// Valid reports whether the lease is valid at time t.
func (l Lease) Valid(t Time) bool { return l.Start <= t && t < l.Expiry }

// Manager issues leases and performs authoritative switches. It is the
// single source of truth; a partitioned old holder may never learn that
// it lost authority, which is why stores also enforce fencing.
type Manager struct {
	fence   uint64
	current Lease
	granted bool
}

// NewManager returns an empty Manager.
func NewManager() *Manager { return &Manager{} }

// Current returns the latest lease and whether one exists.
func (m *Manager) Current() (Lease, bool) { return m.current, m.granted }

// Grant issues a fresh lease to holder, superseding any previous lease.
// The fence number strictly increases on every call.
func (m *Manager) Grant(holder string, now Time, ttl uint64) Lease {
	m.fence++
	m.current = Lease{Holder: holder, Fence: m.fence, Start: now, Expiry: now + Time(ttl)}
	m.granted = true
	return m.current
}

// Renew extends the current holder's lease. It fails if the caller is
// not the current holder, presents a stale fence, or the lease has
// already expired at now (expiry is exclusive).
func (m *Manager) Renew(holder string, fence uint64, now Time, ttl uint64) (Lease, error) {
	if !m.granted {
		return Lease{}, ErrUnknownHolder
	}
	if m.current.Holder != holder {
		return Lease{}, ErrNotHolder
	}
	if fence != m.current.Fence {
		return Lease{}, ErrStaleFence
	}
	if !m.current.Valid(now) {
		return Lease{}, ErrExpired
	}
	m.fence++
	m.current = Lease{Holder: holder, Fence: m.fence, Start: now, Expiry: now + Time(ttl)}
	return m.current, nil
}

// Switch performs an authoritative switch to a new holder. It is only
// legal once the previous lease has expired at now; to cut over earlier
// (e.g. after declaring a partitioned holder dead) use ForceSwitch.
func (m *Manager) Switch(holder string, now Time, ttl uint64) (Lease, error) {
	if m.granted && m.current.Valid(now) {
		return Lease{}, errors.New("lease: previous lease still valid")
	}
	return m.Grant(holder, now, ttl), nil
}

// ForceSwitch revokes the current holder immediately and grants to
// holder, even if the old lease is still valid. The old holder is not
// notified; fencing at the store is what stops its writes.
func (m *Manager) ForceSwitch(holder string, now Time, ttl uint64) Lease {
	return m.Grant(holder, now, ttl)
}

// ValidAt reports whether (holder, fence) names the current lease and
// that lease is valid at t.
func (m *Manager) ValidAt(holder string, fence uint64, t Time) bool {
	return m.granted && m.current.Holder == holder &&
		m.current.Fence == fence && m.current.Valid(t)
}

// Store is a fenced resource guarded by a Manager. A write is legal
// only if its lease is currently valid and its fence is at least the
// highest fence the store has ever accepted (equal is fine: one holder
// may write many times under the same lease). The fence check alone
// rejects a stale holder even if it never observed its invalidation,
// because every new grant carries a strictly greater fence.
type Store struct {
	m        *Manager
	maxFence uint64
	writes   []Write
}

// Write is an accepted write record.
type Write struct {
	Holder string
	Fence  uint64
	At     Time
	Data   string
	// LeaseStart and LeaseExpiry capture the half-open validity
	// interval of the lease that authorized this write.
	LeaseStart  Time
	LeaseExpiry Time
}

// NewStore returns a Store guarded by m.
func NewStore(m *Manager) *Store { return &Store{m: m} }

// MaxFence returns the highest fence the store has accepted.
func (s *Store) MaxFence() uint64 { return s.maxFence }

// Writes returns the accepted writes in order.
func (s *Store) Writes() []Write { return append([]Write(nil), s.writes...) }

// Write attempts a fenced write at time now.
func (s *Store) Write(holder string, fence uint64, now Time, data string) error {
	if fence < s.maxFence {
		return ErrStaleFence
	}
	if !s.m.ValidAt(holder, fence, now) {
		return ErrNotHolder
	}
	s.maxFence = fence
	cur, _ := s.m.Current()
	s.writes = append(s.writes, Write{
		Holder: holder, Fence: fence, At: now, Data: data,
		LeaseStart: cur.Start, LeaseExpiry: cur.Expiry,
	})
	return nil
}
