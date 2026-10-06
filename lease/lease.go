// Package lease implements a lock lease library driven by an explicit
// logical clock. Renewals carry a generation and a request ID: duplicate
// requests return the original expiry without extending it. Expiry is
// evaluated before renewal at the same tick, and a stale holder can never
// release or renew a lease that has been re-granted to a new owner.
package lease

import "sync"

// Clock is an explicit logical clock. It never advances on its own; the
// caller drives time by calling Advance.
type Clock struct {
	now uint64
}

// NewClock returns a Clock starting at the given tick.
func NewClock(start uint64) *Clock { return &Clock{now: start} }

// Now returns the current logical tick.
func (c *Clock) Now() uint64 { return c.now }

// Advance moves the clock forward by delta ticks and returns the new tick.
func (c *Clock) Advance(delta uint64) uint64 {
	c.now += delta
	return c.now
}

// Grant is the generation token handed out with every successful acquire
// or renew. Owner + Generation uniquely identify a lease epoch and act as
// a fencing token for downstream systems.
type Grant struct {
	Owner      string
	Generation uint64
	Expiry     uint64
}

type leaseState struct {
	owner      string
	generation uint64
	expiry     uint64
	// requests records requestID -> granted expiry for idempotent renewals.
	requests map[uint64]uint64
}

// Manager coordinates a single lock lease. It is safe for concurrent use.
type Manager struct {
	mu      sync.Mutex
	clock   *Clock
	lease   *leaseState
	nextGen uint64
}

// NewManager returns a Manager driven by the given logical clock.
func NewManager(clock *Clock) *Manager {
	return &Manager{clock: clock, nextGen: 1}
}

// expiredLocked reports whether the current lease is expired at the
// present tick. A lease whose expiry equals now is already expired:
// expiry is evaluated before any same-tick renewal.
func (m *Manager) expiredLocked() bool {
	return m.lease == nil || m.clock.Now() >= m.lease.expiry
}

// Acquire grants the lease to owner for ttl ticks. It fails if a live
// lease is held by anyone. Each successful grant mints a fresh,
// monotonically increasing generation.
func (m *Manager) Acquire(owner string, ttl uint64) (Grant, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.expiredLocked() {
		return Grant{}, false
	}
	generation := m.nextGen
	m.nextGen++
	m.lease = &leaseState{
		owner:      owner,
		generation: generation,
		expiry:     m.clock.Now() + ttl,
		requests:   make(map[uint64]uint64),
	}
	return Grant{Owner: owner, Generation: generation, Expiry: m.lease.expiry}, true
}

// Renew extends the lease held by (owner, generation) for ttl ticks.
//
// Semantics:
//   - Expiry is checked first: if the lease is expired at the current
//     tick (including expiry == now), the renewal fails.
//   - A generation mismatch means the caller is a stale holder and fails.
//   - A repeated requestID returns the original grant unchanged; it never
//     extends the lease a second time.
func (m *Manager) Renew(owner string, generation, requestID, ttl uint64) (Grant, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.expiredLocked() {
		return Grant{}, false
	}
	if m.lease.owner != owner || m.lease.generation != generation {
		return Grant{}, false
	}
	if expiry, seen := m.lease.requests[requestID]; seen {
		return Grant{Owner: owner, Generation: generation, Expiry: expiry}, true
	}
	m.lease.expiry = m.clock.Now() + ttl
	m.lease.requests[requestID] = m.lease.expiry
	return Grant{Owner: owner, Generation: generation, Expiry: m.lease.expiry}, true
}

// Release drops the lease only if (owner, generation) matches the live
// lease. A stale holder from a previous generation cannot disturb the
// current lease.
func (m *Manager) Release(owner string, generation uint64) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.expiredLocked() {
		return false
	}
	if m.lease.owner != owner || m.lease.generation != generation {
		return false
	}
	m.lease = nil
	return true
}

// Snapshot returns the live lease as a Grant, or ok == false if the lease
// is free or expired at the current tick.
func (m *Manager) Snapshot() (Grant, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.expiredLocked() {
		return Grant{}, false
	}
	return Grant{
		Owner:      m.lease.owner,
		Generation: m.lease.generation,
		Expiry:     m.lease.expiry,
	}, true
}
