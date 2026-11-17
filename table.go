package formal

import (
	"fmt"
	"sort"
	"sync"
	"time"
)

// Config controls a Table. The zero value is usable: the table starts with no
// backends, idle expiry is disabled, and the default ring density is used.
type Config struct {
	// Backends is the initial backend set.
	Backends []Backend
	// IdleTimeout enables idle expiry when positive. Sweep closes active
	// connections whose LastSeen is at least this old.
	IdleTimeout time.Duration
	// VirtualNodesPerWeight controls ring density. Larger values reduce
	// distribution error at the cost of memory. Values <= 0 use the default.
	VirtualNodesPerWeight int
	// Now supplies the clock used by Open, Touch, Close, and Sweep. Nil means
	// time.Now.
	Now func() time.Time
}

type flow struct {
	generation uint64
	backend    Backend
	state      State
	openedAt   time.Time
	lastSeen   time.Time
	closedAt   time.Time
}

// Table is a concurrency-safe five-tuple connection table.
//
// Active connections keep their original backend for the lifetime of the
// generation, even if the backend is removed from the configured set or is
// drained. Closed entries remain as tombstones: reopening the same five-tuple
// preserves its backend when that backend is still eligible, and backend
// changes may rebalance only those closed tombstones.
type Table struct {
	mu sync.RWMutex

	now      func() time.Time
	idle     time.Duration
	vnodes   int
	ring     *hashRing
	backends map[string]Backend
	draining map[string]bool
	flows    map[FiveTuple]*flow
	nextGen  uint64
	stats    Stats
}

// NewTable creates a table and installs the initial backend set.
func NewTable(cfg Config) (*Table, error) {
	if cfg.IdleTimeout < 0 {
		return nil, fmt.Errorf("formal: negative idle timeout %s", cfg.IdleTimeout)
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	t := &Table{
		now:      now,
		idle:     cfg.IdleTimeout,
		vnodes:   cfg.VirtualNodesPerWeight,
		backends: make(map[string]Backend),
		draining: make(map[string]bool),
		flows:    make(map[FiveTuple]*flow),
	}
	if err := t.SetBackends(cfg.Backends); err != nil {
		return nil, err
	}
	return t, nil
}

// SetBackends atomically replaces the configured backend set. Draining flags
// are retained for backend IDs that remain present. Active connections are not
// touched; closed tombstones whose backend is no longer eligible are moved to
// the new ring.
func (t *Table) SetBackends(backends []Backend) error {
	next := make(map[string]Backend, len(backends))
	for _, b := range backends {
		if err := b.validate(); err != nil {
			return err
		}
		if _, exists := next[b.ID]; exists {
			return fmt.Errorf("%w: duplicate ID %q", ErrInvalidBackend, b.ID)
		}
		next[b.ID] = b
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	draining := make(map[string]bool, len(next))
	for id := range next {
		if t.draining[id] {
			draining[id] = true
		}
	}
	t.backends = next
	t.draining = draining
	t.rebuildRingLocked()
	t.rebalanceClosedLocked()
	return nil
}

// Drain stops new assignments to a backend and immediately migrates its closed
// tombstones. Connections that are still active stay pinned to the backend;
// they are migrated later, when they close or expire.
func (t *Table) Drain(id string) (DrainResult, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if _, ok := t.backends[id]; !ok {
		return DrainResult{}, fmt.Errorf("%w: %q", ErrUnknownBackend, id)
	}
	t.draining[id] = true
	t.rebuildRingLocked()

	res := DrainResult{Migrated: t.migrateClosedFromLocked(id)}
	for _, f := range t.flows {
		if f.state == StateActive && f.backend.ID == id {
			res.Active++
		}
	}
	return res, nil
}

// Undrain makes a backend eligible for new connections again. Existing
// bindings are not disturbed.
func (t *Table) Undrain(id string) error {
	t.mu.Lock()
	defer t.mu.Unlock()

	if _, ok := t.backends[id]; !ok {
		return fmt.Errorf("%w: %q", ErrUnknownBackend, id)
	}
	delete(t.draining, id)
	t.rebuildRingLocked()
	return nil
}

// Open establishes the five-tuple and returns its new generation.
//
// A previously unseen tuple, and a closed tuple whose old backend is no longer
// eligible, is assigned by weighted consistent hash. A closed tuple whose old
// backend is still eligible reuses that backend for affinity. Open fails with
// ErrFlowActive if the tuple is already active, which is the NAT port-reuse
// collision case and must never be silently shared.
func (t *Table) Open(key FiveTuple) (Conn, error) {
	if !key.Valid() {
		return Conn{}, ErrInvalidKey
	}
	key = key.Normalized()
	now := t.now()

	t.mu.Lock()
	defer t.mu.Unlock()

	if f, ok := t.flows[key]; ok {
		if f.state == StateActive {
			t.stats.RejectedOpens++
			return Conn{}, ErrFlowActive
		}

		backend, ok := t.backendForReopenLocked(key, f.backend.ID)
		if !ok {
			t.stats.RejectedOpens++
			return Conn{}, ErrNoBackends
		}
		f.generation = t.nextGenerationLocked()
		f.backend = backend
		f.state = StateActive
		f.openedAt = now
		f.lastSeen = now
		f.closedAt = time.Time{}
		t.stats.Active++
		t.stats.Closed--
		t.stats.Reopens++
		return snapshot(key, f), nil
	}

	backend, ok := t.pickLocked(key)
	if !ok {
		t.stats.RejectedOpens++
		return Conn{}, ErrNoBackends
	}
	f := &flow{
		generation: t.nextGenerationLocked(),
		backend:    backend,
		state:      StateActive,
		openedAt:   now,
		lastSeen:   now,
	}
	t.flows[key] = f
	t.stats.Active++
	t.stats.Opens++
	return snapshot(key, f), nil
}

// Lookup returns a snapshot of the entry for key, active or closed.
func (t *Table) Lookup(key FiveTuple) (Conn, bool) {
	if !key.Valid() {
		return Conn{}, false
	}
	key = key.Normalized()

	t.mu.RLock()
	defer t.mu.RUnlock()
	f, ok := t.flows[key]
	if !ok {
		return Conn{}, false
	}
	return snapshot(key, f), true
}

// Touch refreshes the idle deadline of an active connection. A stale
// generation is rejected.
func (t *Table) Touch(key FiveTuple, generation uint64) (Conn, error) {
	if !key.Valid() {
		return Conn{}, ErrInvalidKey
	}
	key = key.Normalized()
	now := t.now()

	t.mu.Lock()
	defer t.mu.Unlock()
	f, ok := t.flows[key]
	if !ok {
		return Conn{}, ErrUnknownFlow
	}
	if f.generation != generation {
		t.stats.StaleReleases++
		return Conn{}, ErrStaleGeneration
	}
	if f.state != StateActive {
		return Conn{}, ErrFlowClosed
	}
	if now.After(f.lastSeen) {
		f.lastSeen = now
	}
	return snapshot(key, f), nil
}

// Close releases a connection. generation must be the value returned by the
// Open that created the current entry. A release from an older generation is
// rejected with ErrStaleGeneration and cannot remove a replacement connection.
//
// Releasing an already closed entry with the same generation is idempotent.
// If the entry's backend is draining or no longer configured, the tombstone is
// moved to an eligible backend immediately.
func (t *Table) Close(key FiveTuple, generation uint64) (CloseResult, error) {
	if !key.Valid() {
		return CloseResult{}, ErrInvalidKey
	}
	key = key.Normalized()
	now := t.now()

	t.mu.Lock()
	defer t.mu.Unlock()
	f, ok := t.flows[key]
	if !ok {
		t.stats.StaleReleases++
		return CloseResult{}, ErrUnknownFlow
	}
	if f.generation != generation {
		t.stats.StaleReleases++
		return CloseResult{}, ErrStaleGeneration
	}
	if f.state == StateClosed {
		return CloseResult{Backend: f.backend}, nil
	}

	f.state = StateClosed
	f.closedAt = now
	if now.After(f.lastSeen) {
		f.lastSeen = now
	}
	t.stats.Active--
	t.stats.Closed++
	t.stats.Closes++

	res := CloseResult{Closed: true, Backend: f.backend}
	if !t.eligibleLocked(f.backend.ID) {
		if backend, ok := t.pickLocked(key); ok {
			f.backend = backend
			t.stats.Migrations++
			res.Migrated = true
			res.Backend = backend
		}
	}
	return res, nil
}

// CloseConn is a convenience wrapper around Close.
func (t *Table) CloseConn(c Conn) (CloseResult, error) {
	return t.Close(c.Key, c.Generation)
}

// Forget removes a closed tombstone. It refuses to remove an active entry.
func (t *Table) Forget(key FiveTuple, generation uint64) error {
	if !key.Valid() {
		return ErrInvalidKey
	}
	key = key.Normalized()

	t.mu.Lock()
	defer t.mu.Unlock()
	f, ok := t.flows[key]
	if !ok {
		return ErrUnknownFlow
	}
	if f.generation != generation {
		t.stats.StaleReleases++
		return ErrStaleGeneration
	}
	if f.state == StateActive {
		return ErrFlowActive
	}
	delete(t.flows, key)
	t.stats.Closed--
	return nil
}

// Sweep expires idle active connections using the table clock. It returns the
// number of connections closed by this call.
func (t *Table) Sweep() int {
	return t.Expire(t.now())
}

// Expire closes active connections whose LastSeen is at least the configured
// IdleTimeout before now. Expired connections become tombstones; if their
// backend is no longer eligible, they are migrated like explicitly closed
// connections.
func (t *Table) Expire(now time.Time) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.idle <= 0 {
		return 0
	}

	expired := 0
	for key, f := range t.flows {
		if f.state != StateActive || now.Before(f.lastSeen.Add(t.idle)) {
			continue
		}
		f.state = StateClosed
		f.closedAt = now
		if now.After(f.lastSeen) {
			f.lastSeen = now
		}
		t.stats.Active--
		t.stats.Closed++
		t.stats.Closes++
		t.stats.Expired++
		expired++

		if !t.eligibleLocked(f.backend.ID) {
			if backend, ok := t.pickLocked(key); ok {
				f.backend = backend
				t.stats.Migrations++
			}
		}
	}
	return expired
}

// Stats returns a point-in-time snapshot.
func (t *Table) Stats() Stats {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.stats
}

// Len returns the number of entries, including closed tombstones.
func (t *Table) Len() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return len(t.flows)
}

// Backends returns the configured backend set and ring density, sorted by ID.
func (t *Table) Backends() []BackendStatus {
	t.mu.RLock()
	defer t.mu.RUnlock()

	counts := t.ring.vnodeCounts()
	out := make([]BackendStatus, 0, len(t.backends))
	for id, b := range t.backends {
		out = append(out, BackendStatus{
			Backend:  b,
			Draining: t.draining[id],
			VNodes:   counts[id],
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Backend.ID < out[j].Backend.ID })
	return out
}

func (t *Table) rebuildRingLocked() {
	eligible := make([]Backend, 0, len(t.backends))
	for id, b := range t.backends {
		if !t.draining[id] {
			eligible = append(eligible, b)
		}
	}
	t.ring = buildRing(eligible, t.vnodes)
}

func (t *Table) eligibleLocked(id string) bool {
	_, ok := t.backends[id]
	return ok && !t.draining[id]
}

func (t *Table) pickLocked(key FiveTuple) (Backend, bool) {
	id, ok := t.ring.pick(hashTuple(key))
	if !ok {
		return Backend{}, false
	}
	b, ok := t.backends[id]
	return b, ok
}

func (t *Table) backendForReopenLocked(key FiveTuple, oldID string) (Backend, bool) {
	if t.eligibleLocked(oldID) {
		return t.backends[oldID], true
	}
	return t.pickLocked(key)
}

func (t *Table) nextGenerationLocked() uint64 {
	t.nextGen++
	t.stats.Generations++
	return t.nextGen
}

// rebalanceClosedLocked moves only tombstones. Active bindings are never
// rewritten here.
func (t *Table) rebalanceClosedLocked() int {
	migrated := 0
	for key, f := range t.flows {
		if f.state != StateClosed || t.eligibleLocked(f.backend.ID) {
			continue
		}
		if backend, ok := t.pickLocked(key); ok {
			f.backend = backend
			migrated++
		}
	}
	t.stats.Migrations += uint64(migrated)
	return migrated
}

// migrateClosedFromLocked moves tombstones from one backend that has just
// become ineligible. Unlike a backend-set replacement, draining reports only
// the entries that belonged to the drained backend.
func (t *Table) migrateClosedFromLocked(id string) int {
	migrated := 0
	for key, f := range t.flows {
		if f.state != StateClosed || f.backend.ID != id {
			continue
		}
		if backend, ok := t.pickLocked(key); ok {
			f.backend = backend
			migrated++
		}
	}
	t.stats.Migrations += uint64(migrated)
	return migrated
}

func snapshot(key FiveTuple, f *flow) Conn {
	return Conn{
		Key:        key,
		Generation: f.generation,
		Backend:    f.backend,
		State:      f.state,
		OpenedAt:   f.openedAt,
		LastSeen:   f.lastSeen,
		ClosedAt:   f.closedAt,
	}
}
