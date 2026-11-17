package formal

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"time"
)

var errNilContext = errors.New("formal: nil context")

// Machine is one participant in a cluster-scoped leader election. It contains
// no goroutines; the surrounding controller must call Tick when its timer
// fires and must use IsLeader to gate every action that requires exclusivity.
//
// Machine is safe for concurrent use. A Store call made by Tick must not call
// back into the same Machine.
type Machine struct {
	mu    sync.Mutex
	cfg   Config
	clock Clock
	store Store
	key   LeaseKey

	state       State
	term        uint64
	observed    Lease
	hasObserved bool

	leaderUntil      time.Time
	lastRenewAttempt time.Time
	lastErr          error
	needsReconcile   bool
}

// New validates cfg and constructs a Machine in Follower state.
func New(cfg Config, store Store, clock Clock) (*Machine, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if store == nil {
		return nil, fmt.Errorf("%w: store is required", ErrInvalidConfig)
	}
	if clock == nil {
		return nil, fmt.Errorf("%w: clock is required", ErrInvalidConfig)
	}
	return &Machine{
		cfg:   cfg,
		clock: clock,
		store: store,
		key:   LeaseKey{Cluster: cfg.Cluster, Name: cfg.LeaseName},
		state: Follower,
	}, nil
}

// Tick performs one reconciliation step. It either renews leadership, checks
// whether an observed lease may be replaced, or tries to acquire the lease.
//
// A store error does not by itself revoke leadership: the leader keeps serving
// until its last confirmed ExpiresAt. Likewise, an unconfirmed renewal never
// extends the local deadline. Callers should log errors and keep ticking.
//
// The tick that observes an expired leader deadline only steps down. A later
// tick may campaign with a new term, so a recovered old leader cannot renew
// its previous term.
func (m *Machine) Tick(ctx context.Context) error {
	if ctx == nil {
		return errNilContext
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	now := m.clock.Now()
	if m.state == Leader {
		// Step down before touching the store. This is the recovery rule for a
		// leader that was partitioned or paused past its deadline.
		if !now.Before(m.leaderUntil) {
			m.stepDownLocked()
			m.lastErr = nil
			return nil
		}
		// A previous renewal ended with an ambiguous error. Read the store
		// before waiting for the next renewal interval: the write may have
		// succeeded even though its reply was lost.
		if m.needsReconcile {
			m.needsReconcile = false
			err := m.reconcileLeaderLocked(ctx, now)
			if err != nil {
				m.needsReconcile = true
			}
			m.lastErr = err
			return err
		}
		if now.Sub(m.lastRenewAttempt) < m.cfg.RenewInterval {
			return nil
		}
		m.lastRenewAttempt = now
		err := m.renewLocked(ctx, now)
		m.lastErr = err
		m.needsReconcile = err != nil && m.state == Leader
		return err
	}

	err := m.campaignLocked(ctx, now)
	m.lastErr = err
	return err
}

func (m *Machine) renewLocked(ctx context.Context, now time.Time) error {
	if !m.hasObserved || m.observed.Holder != m.cfg.Holder || m.observed.Term != m.term {
		m.stepDownLocked()
		return nil
	}

	next := m.newLeaseLocked(m.term, now)
	updated, err := m.store.Update(ctx, next, m.observed.ResourceVersion)
	if err == nil {
		if err := m.acceptLeaderLeaseLocked(updated, m.term, now); err != nil {
			m.stepDownLocked()
			return err
		}
		return nil
	}

	// The store changed underneath us. It may be a lost renewal response (our
	// own write won but the reply was dropped), a competing writer, or a
	// version bump. Re-read and decide from the authoritative value.
	if errors.Is(err, ErrResourceVersionConflict) || errors.Is(err, ErrLeaseNotFound) {
		return m.reconcileLeaderLocked(ctx, now)
	}
	return err
}

func (m *Machine) reconcileLeaderLocked(ctx context.Context, now time.Time) error {
	ownTerm := m.term
	current, ok, err := m.store.Get(ctx, m.key)
	if err != nil {
		return err
	}
	if !ok {
		m.stepDownLocked()
		return nil
	}
	if err := m.observeLocked(current); err != nil {
		m.stepDownLocked()
		return err
	}

	// Only the exact same holder and term may be adopted. A higher term, even
	// with the same holder string, means this process is an old incarnation and
	// must not resume acting as leader.
	if current.Term == ownTerm && current.Holder == m.cfg.Holder {
		if !now.Before(current.ExpiresAt) {
			m.stepDownLocked()
			return nil
		}
		m.state = Leader
		m.leaderUntil = current.ExpiresAt
		return nil
	}

	m.stepDownLocked()
	return nil
}

func (m *Machine) campaignLocked(ctx context.Context, now time.Time) error {
	current, ok, err := m.store.Get(ctx, m.key)
	if err != nil {
		return err
	}
	if !ok {
		return m.createLocked(ctx, now)
	}
	if err := m.observeLocked(current); err != nil {
		m.stepDownLocked()
		return err
	}

	// This is the safety gate. Because ExpiresAt was written on the old
	// holder's clock, waiting for ExpiresAt plus the full skew bound ensures
	// that even the fastest observing clock cannot race the slowest old
	// holder's deadline.
	if !now.After(current.ExpiresAt.Add(m.cfg.ClockSkewBound)) {
		m.state = Follower
		return nil
	}

	if m.term == math.MaxUint64 {
		m.stepDownLocked()
		return ErrTermOverflow
	}
	nextTerm := m.term + 1
	next := m.newLeaseLocked(nextTerm, now)
	updated, err := m.store.Update(ctx, next, current.ResourceVersion)
	if err == nil {
		if err := m.acceptLeaderLeaseLocked(updated, nextTerm, now); err != nil {
			m.stepDownLocked()
			return err
		}
		m.lastRenewAttempt = now
		return nil
	}
	if errors.Is(err, ErrResourceVersionConflict) || errors.Is(err, ErrLeaseNotFound) {
		// Another candidate won, or the lease moved. Re-read on the next tick;
		// never overwrite an unseen value.
		m.state = Candidate
		return nil
	}
	return err
}

func (m *Machine) createLocked(ctx context.Context, now time.Time) error {
	if m.term == math.MaxUint64 {
		return ErrTermOverflow
	}
	nextTerm := m.term + 1
	next := m.newLeaseLocked(nextTerm, now)
	created, err := m.store.Create(ctx, next)
	if err == nil {
		if err := m.acceptLeaderLeaseLocked(created, nextTerm, now); err != nil {
			m.stepDownLocked()
			return err
		}
		m.lastRenewAttempt = now
		return nil
	}
	if errors.Is(err, ErrResourceVersionConflict) {
		m.state = Candidate
		return nil
	}
	return err
}

func (m *Machine) newLeaseLocked(term uint64, now time.Time) Lease {
	return Lease{
		Cluster:   m.cfg.Cluster,
		Name:      m.cfg.LeaseName,
		Holder:    m.cfg.Holder,
		Term:      term,
		RenewedAt: now,
		ExpiresAt: now.Add(m.cfg.LeaseDuration),
	}
}

func (m *Machine) observeLocked(lease Lease) error {
	if err := lease.Validate(); err != nil {
		return err
	}
	if lease.Key() != m.key {
		return fmt.Errorf("%w: got %s, want %s", ErrClusterMismatch, lease.Key(), m.key)
	}
	if lease.ResourceVersion == 0 {
		return fmt.Errorf("%w: zero resource version", ErrInvalidLease)
	}
	m.observed = lease
	m.hasObserved = true
	if lease.Term > m.term {
		m.term = lease.Term
	}
	return nil
}

func (m *Machine) acceptLeaderLeaseLocked(lease Lease, expectedTerm uint64, now time.Time) error {
	if err := m.observeLocked(lease); err != nil {
		return err
	}
	if lease.Holder != m.cfg.Holder {
		return fmt.Errorf("%w: store returned holder %q", ErrInvalidLease, lease.Holder)
	}
	if lease.Term != expectedTerm {
		return fmt.Errorf("%w: store returned term %d, want %d", ErrInvalidLease, lease.Term, expectedTerm)
	}
	if !now.Before(lease.ExpiresAt) {
		m.stepDownLocked()
		return nil
	}
	m.state = Leader
	m.term = lease.Term
	m.leaderUntil = lease.ExpiresAt
	m.needsReconcile = false
	return nil
}

func (m *Machine) stepDownLocked() {
	m.state = Follower
	m.leaderUntil = time.Time{}
	m.needsReconcile = false
}

// State returns the current role. If the local deadline has passed since the
// last Tick, State reports Follower even before the next Tick records it.
func (m *Machine) State() State {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state == Leader && !m.clock.Now().Before(m.leaderUntil) {
		return Follower
	}
	return m.state
}

// IsLeader reports whether this process may perform leader-only actions now.
// It re-checks the local deadline, so a paused leader stops acting even if it
// has not ticked since the pause.
func (m *Machine) IsLeader() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state == Leader && m.clock.Now().Before(m.leaderUntil)
}

// LeaderUntil returns the locally confirmed lease deadline. The boolean is
// false when the machine is not currently a leader. The deadline may already
// be in the past if no Tick has observed the expiration yet; use IsLeader for
// the authoritative check.
func (m *Machine) LeaderUntil() (time.Time, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state != Leader {
		return time.Time{}, false
	}
	return m.leaderUntil, true
}

// Term returns the highest term this Machine has observed or used.
func (m *Machine) Term() uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.term
}

// ObservedLease returns the last lease value read from the store.
func (m *Machine) ObservedLease() (Lease, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.observed, m.hasObserved
}

// LastError returns the error from the most recent Tick that attempted a store
// operation.
func (m *Machine) LastError() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lastErr
}

// Key returns the cluster-scoped lease key used by this Machine.
func (m *Machine) Key() LeaseKey {
	return m.key
}
