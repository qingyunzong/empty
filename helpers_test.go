package formal

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

var (
	testEpoch    = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	testDuration = 10 * time.Second
	testRenew    = 2 * time.Second
	testSkew     = time.Second
)

type manualClock struct {
	mu  sync.Mutex
	now time.Time
}

func newManualClock(now time.Time) *manualClock {
	return &manualClock{now: now}
}

func (c *manualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *manualClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

type skewedClock struct {
	base   *manualClock
	offset time.Duration
}

func (c skewedClock) Now() time.Time {
	return c.base.Now().Add(c.offset)
}

func testConfig(cluster, holder string) Config {
	return Config{
		Cluster:        cluster,
		LeaseName:      "controller",
		Holder:         holder,
		LeaseDuration:  testDuration,
		RenewInterval:  testRenew,
		ClockSkewBound: testSkew,
	}
}

func mustMachine(t *testing.T, cfg Config, store Store, clock Clock) *Machine {
	t.Helper()
	m, err := New(cfg, store, clock)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return m
}

func mustTick(t *testing.T, m *Machine) error {
	t.Helper()
	return m.Tick(context.Background())
}

func mustLeader(t *testing.T, m *Machine) {
	t.Helper()
	if !m.IsLeader() {
		t.Fatalf("%s is not leader (state=%s, err=%v)", m.cfg.Holder, m.State(), m.LastError())
	}
}

func mustNotLeader(t *testing.T, m *Machine) {
	t.Helper()
	if m.IsLeader() {
		t.Fatalf("%s unexpectedly is leader", m.cfg.Holder)
	}
}

func requireAtMostOneLeader(t *testing.T, machines ...*Machine) {
	t.Helper()
	leader := ""
	for _, m := range machines {
		if !m.IsLeader() {
			continue
		}
		if leader != "" {
			t.Fatalf("dual leaders: %s and %s", leader, m.cfg.Holder)
		}
		leader = m.cfg.Holder
	}
}

func countLeaders(machines []*Machine) int {
	count := 0
	for _, m := range machines {
		if m.IsLeader() {
			count++
		}
	}
	return count
}

var errInjected = errors.New("injected store failure")

// faultStore injects the failures a real controller sees: dropped requests,
// lost responses after a successful write, failed reads, and full isolation.
type faultStore struct {
	inner Store

	mu                sync.Mutex
	dropUpdates       int
	loseUpdateReplies int
	failGets          bool
	offline           bool
}

func newFaultStore(inner Store) *faultStore {
	return &faultStore{inner: inner}
}

func (s *faultStore) setDropUpdates(n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropUpdates = n
}

func (s *faultStore) setLoseUpdateReplies(n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loseUpdateReplies = n
}

func (s *faultStore) setFailGets(fail bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failGets = fail
}

func (s *faultStore) setOffline(offline bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.offline = offline
}

func (s *faultStore) isOffline() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.offline
}

func (s *faultStore) Get(ctx context.Context, key LeaseKey) (Lease, bool, error) {
	if s.isOffline() {
		return Lease{}, false, fmt.Errorf("%w: get", errInjected)
	}
	s.mu.Lock()
	fail := s.failGets
	s.mu.Unlock()
	if fail {
		return Lease{}, false, fmt.Errorf("%w: get", errInjected)
	}
	return s.inner.Get(ctx, key)
}

func (s *faultStore) Create(ctx context.Context, lease Lease) (Lease, error) {
	if s.isOffline() {
		return Lease{}, fmt.Errorf("%w: create", errInjected)
	}
	return s.inner.Create(ctx, lease)
}

func (s *faultStore) Update(ctx context.Context, lease Lease, expected uint64) (Lease, error) {
	s.mu.Lock()
	if s.offline {
		s.mu.Unlock()
		return Lease{}, fmt.Errorf("%w: update", errInjected)
	}
	if s.dropUpdates > 0 {
		s.dropUpdates--
		s.mu.Unlock()
		return Lease{}, fmt.Errorf("%w: dropped update", errInjected)
	}
	if s.loseUpdateReplies > 0 {
		s.loseUpdateReplies--
		s.mu.Unlock()
		_, err := s.inner.Update(ctx, lease, expected)
		if err != nil {
			return Lease{}, err
		}
		return Lease{}, fmt.Errorf("%w: lost update reply", errInjected)
	}
	s.mu.Unlock()
	return s.inner.Update(ctx, lease, expected)
}

// conflictStore injects a competing write immediately before one Update. It
// is used both for an acquisition race and for a stale-leader renewal.
type conflictStore struct {
	inner Store

	mu         sync.Mutex
	armed      bool
	competitor Lease
	bump       bool

	createArmed      bool
	createCompetitor Lease
}

func newConflictStore(inner Store) *conflictStore {
	return &conflictStore{inner: inner}
}

func (s *conflictStore) armCompetitor(competitor Lease) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.armed = true
	s.competitor = competitor
	s.bump = false
}

func (s *conflictStore) armVersionBump() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.armed = true
	s.bump = true
}

func (s *conflictStore) armCreateCompetitor(competitor Lease) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.createArmed = true
	s.createCompetitor = competitor
}

func (s *conflictStore) Get(ctx context.Context, key LeaseKey) (Lease, bool, error) {
	return s.inner.Get(ctx, key)
}

func (s *conflictStore) Create(ctx context.Context, lease Lease) (Lease, error) {
	s.mu.Lock()
	if s.createArmed {
		s.createArmed = false
		competitor := s.createCompetitor
		s.mu.Unlock()
		if _, err := s.inner.Create(ctx, competitor); err != nil {
			return Lease{}, err
		}
		return Lease{}, ErrResourceVersionConflict
	}
	s.mu.Unlock()
	return s.inner.Create(ctx, lease)
}

func (s *conflictStore) Update(ctx context.Context, lease Lease, expected uint64) (Lease, error) {
	s.mu.Lock()
	if !s.armed {
		s.mu.Unlock()
		return s.inner.Update(ctx, lease, expected)
	}
	s.armed = false
	competitor := s.competitor
	bump := s.bump
	s.mu.Unlock()

	if bump {
		current, ok, err := s.inner.Get(ctx, lease.Key())
		if err != nil {
			return Lease{}, err
		}
		if ok {
			if _, err := s.inner.Update(ctx, current, current.ResourceVersion); err != nil {
				return Lease{}, err
			}
		}
		return Lease{}, ErrResourceVersionConflict
	}

	if _, err := s.inner.Update(ctx, competitor, expected); err != nil {
		return Lease{}, err
	}
	return Lease{}, ErrResourceVersionConflict
}

// poisonStore returns a fixed lease for every read. It models a backend bug or
// a namespace leak across clusters.
type poisonStore struct {
	lease Lease
}

func (s poisonStore) Get(context.Context, LeaseKey) (Lease, bool, error) {
	return s.lease, true, nil
}

func (s poisonStore) Create(context.Context, Lease) (Lease, error) {
	return Lease{}, ErrResourceVersionConflict
}

func (s poisonStore) Update(context.Context, Lease, uint64) (Lease, error) {
	return Lease{}, ErrResourceVersionConflict
}
