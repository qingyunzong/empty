// Package leasesim is a single-machine simulation library for lease-based
// authority: grant, renewal and authoritative takeover, with monotonically
// increasing fence numbers attached to every lease write.
//
// Time is explicit: every operation takes an integer timestamp supplied by
// the caller. Lease deadlines are exclusive: a lease is valid at time t iff
// t < Expiry.
package leasesim

import "errors"

var (
	ErrLeaseHeld     = errors.New("leasesim: lease already held by another holder")
	ErrNotHolder     = errors.New("leasesim: caller is not the current lease holder")
	ErrLeaseExpired  = errors.New("leasesim: lease is expired at the given time")
	ErrInvalidTTL    = errors.New("leasesim: ttl must be positive")
	ErrStaleFence    = errors.New("leasesim: fence number is not greater than the last seen fence")
	ErrFenceMismatch = errors.New("leasesim: fence does not match the current lease fence")
)

// Lease describes the current authoritative lease. Expiry is exclusive.
type Lease struct {
	Holder string
	Fence  uint64
	Expiry int64
}

// Valid reports whether the lease is valid at time t (deadline exclusive).
func (l Lease) Valid(t int64) bool {
	return t < l.Expiry
}

// Manager grants, renews and switches leases. The zero value is ready to use.
type Manager struct {
	lease     Lease
	hasLease  bool
	lastFence uint64
}

// Current returns the current lease and whether one exists.
func (m *Manager) Current() (Lease, bool) {
	return m.lease, m.hasLease
}

// LastFence returns the highest fence number ever issued.
func (m *Manager) LastFence() uint64 {
	return m.lastFence
}

// Holder returns the holder of the lease valid at time t, or "" if none.
func (m *Manager) Holder(t int64) string {
	if m.hasLease && m.lease.Valid(t) {
		return m.lease.Holder
	}
	return ""
}

func (m *Manager) issue(holder string, t, ttl int64) (Lease, error) {
	if ttl <= 0 {
		return Lease{}, ErrInvalidTTL
	}
	m.lastFence++
	m.lease = Lease{Holder: holder, Fence: m.lastFence, Expiry: t + ttl}
	m.hasLease = true
	return m.lease, nil
}

// Grant issues a new lease to holder. It fails if the lease of another
// holder is still valid at time t.
func (m *Manager) Grant(holder string, t, ttl int64) (Lease, error) {
	if m.hasLease && m.lease.Valid(t) && m.lease.Holder != holder {
		return Lease{}, ErrLeaseHeld
	}
	return m.issue(holder, t, ttl)
}

// Renew extends the lease of the current holder. Only the holder of a lease
// that is still valid at time t may renew. Renewal bumps the fence number.
func (m *Manager) Renew(holder string, t, ttl int64) (Lease, error) {
	if !m.hasLease || m.lease.Holder != holder {
		return Lease{}, ErrNotHolder
	}
	if !m.lease.Valid(t) {
		return Lease{}, ErrLeaseExpired
	}
	return m.issue(holder, t, ttl)
}

// Takeover performs an authoritative switch: it unconditionally issues the
// lease to holder, invalidating the previous holder immediately, regardless
// of whether the previous holder has observed the invalidation. The fence
// number increases, so writes from the old holder are rejected by fenced
// storage from this point on.
func (m *Manager) Takeover(holder string, t, ttl int64) (Lease, error) {
	return m.issue(holder, t, ttl)
}
