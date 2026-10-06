// Package lease implements a lock lease library driven by an explicit
// logical clock. Time never moves on its own: the caller advances the
// Clock, which makes every expiry/renewal interleaving reproducible.
//
// Semantics:
//   - Acquire hands out a fencing Token carrying a monotonically
//     increasing generation and an absolute expiry tick.
//   - Renew carries the holder's generation plus a caller-supplied
//     request ID. A repeated request ID returns the originally recorded
//     deadline and never extends the lease again (idempotent renewal).
//   - A lease is expired when now >= expiresAt. Expiry is processed
//     before a renewal landing on the same tick, so renewing exactly at
//     the expiry tick fails.
//   - Release only succeeds with the current generation, so a stale
//     holder can never disturb a newer lease on the same key.
package lease

import (
	"errors"
	"sync"
)

var (
	ErrZeroTTL         = errors.New("lease: ttl must be positive")
	ErrLeaseHeld       = errors.New("lease: key is held by a live lease")
	ErrStaleGeneration = errors.New("lease: stale generation token")
	ErrLeaseExpired    = errors.New("lease: lease expired before renewal")
)

// Clock is an explicit logical clock. It only moves when Advance is
// called, so tests and callers control time precisely.
type Clock struct {
	mu  sync.Mutex
	now uint64
}

// NewClock returns a Clock starting at tick 0.
func NewClock() *Clock { return &Clock{} }

// Now returns the current logical tick.
func (c *Clock) Now() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// Advance moves the clock forward by delta ticks and returns the new
// current tick.
func (c *Clock) Advance(delta uint64) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now += delta
	return c.now
}

// Token is the fencing token handed to the holder of a lease. The
// generation strictly increases every time a key is re-acquired.
type Token struct {
	Key        string
	Generation uint64
	ExpiresAt  uint64
}

// Renewal is the outcome of a Renew call. For a duplicate request ID it
// replays the originally recorded outcome, including the original
// deadline, without touching the lease.
type Renewal struct {
	Granted   bool
	ExpiresAt uint64 // deadline recorded by the first attempt; zero if denied
	Err       error  // nil when Granted
}

type leaseState struct {
	generation uint64
	expiresAt  uint64
}

type renewalRecord struct {
	granted   bool
	expiresAt uint64
	err       error
}

// Manager coordinates leases for named keys over a shared Clock.
type Manager struct {
	clock *Clock

	mu       sync.Mutex
	leases   map[string]*leaseState
	renewals map[string]map[string]renewalRecord // key -> request ID -> record
}

// NewManager returns a Manager reading time from clock.
func NewManager(clock *Clock) *Manager {
	return &Manager{
		clock:    clock,
		leases:   make(map[string]*leaseState),
		renewals: make(map[string]map[string]renewalRecord),
	}
}

// Acquire takes a lease on key for ttl ticks. It fails with
// ErrLeaseHeld while a live lease exists; an expired lease (now >=
// expiresAt) is treated as gone and replaced with a new generation.
func (m *Manager) Acquire(key string, ttl uint64) (Token, error) {
	if ttl == 0 {
		return Token{}, ErrZeroTTL
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	now := m.clock.Now()
	generation := uint64(1)
	if l, ok := m.leases[key]; ok {
		if l.expiresAt > now {
			return Token{}, ErrLeaseHeld
		}
		generation = l.generation + 1
	}
	expiresAt := now + ttl
	m.leases[key] = &leaseState{generation: generation, expiresAt: expiresAt}
	return Token{Key: key, Generation: generation, ExpiresAt: expiresAt}, nil
}

// Renew extends the lease held with the given generation. requestID
// makes the call idempotent: the first attempt's outcome is recorded
// and replayed verbatim for any retry, so a duplicate can never extend
// the deadline a second time. A renewal landing on or after the expiry
// tick loses to expiry and is denied with ErrLeaseExpired.
func (m *Manager) Renew(key string, generation uint64, requestID string, ttl uint64) Renewal {
	m.mu.Lock()
	defer m.mu.Unlock()

	if recs, ok := m.renewals[key]; ok {
		if rec, ok := recs[requestID]; ok {
			return Renewal{Granted: rec.granted, ExpiresAt: rec.expiresAt, Err: rec.err}
		}
	}

	rec := renewalRecord{}
	l, ok := m.leases[key]
	switch {
	case ttl == 0:
		rec.err = ErrZeroTTL
	case !ok || l.generation != generation:
		rec.err = ErrStaleGeneration
	case l.expiresAt <= m.clock.Now():
		rec.err = ErrLeaseExpired
	default:
		l.expiresAt = m.clock.Now() + ttl
		rec.granted = true
		rec.expiresAt = l.expiresAt
	}

	if m.renewals[key] == nil {
		m.renewals[key] = make(map[string]renewalRecord)
	}
	m.renewals[key][requestID] = rec
	return Renewal{Granted: rec.granted, ExpiresAt: rec.expiresAt, Err: rec.err}
}

// Release drops the lease on key, but only when generation matches the
// current lease. A stale holder's release is rejected and leaves any
// newer lease untouched.
func (m *Manager) Release(key string, generation uint64) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	l, ok := m.leases[key]
	if !ok || l.generation != generation {
		return ErrStaleGeneration
	}
	delete(m.leases, key)
	return nil
}

// Inspect returns the token of the currently live lease on key, or
// false if no live lease exists. Expired-but-not-yet-replaced leases
// are reported as absent.
func (m *Manager) Inspect(key string) (Token, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	l, ok := m.leases[key]
	if !ok || l.expiresAt <= m.clock.Now() {
		return Token{}, false
	}
	return Token{Key: key, Generation: l.generation, ExpiresAt: l.expiresAt}, true
}
