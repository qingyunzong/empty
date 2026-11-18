package formal

import (
	"math/rand"
	"sort"
	"sync"
)

// Instance is an immutable view of one live instance.
type Instance struct {
	ID         InstanceID
	Generation uint64
	Health     Health
	Weight     uint32
	Drain      DrainState
	Available  bool
}

// ApplyResult reports whether Apply changed the aggregated state.
type ApplyResult uint8

const (
	// ResultIgnored means the event was a duplicate or was superseded by a
	// newer generation or revision.
	ResultIgnored ApplyResult = iota
	// ResultApplied means the event was folded into the table.
	ResultApplied
)

// Option configures an Aggregator.
type Option func(*Aggregator)

// WithDefaultWeight sets the weight used before the first weight observation
// for an instance generation. The default is 1.
func WithDefaultWeight(weight uint32) Option {
	return func(a *Aggregator) {
		a.defaultWeight = weight
		a.weightReady = true
	}
}

// Aggregator merges discovery observations for a set of instances.
//
// The zero value is ready to use and behaves like New(). An Aggregator must
// not be copied after first use.
type Aggregator struct {
	mu sync.RWMutex

	defaultWeight uint32
	weightReady   bool
	instances     map[InstanceID]*instanceState

	applied uint64
	ignored uint64
}

// New creates an empty Aggregator.
func New(opts ...Option) *Aggregator {
	a := &Aggregator{
		defaultWeight: 1,
		weightReady:   true,
		instances:     make(map[InstanceID]*instanceState),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(a)
		}
	}
	return a
}

type observation[T any] struct {
	revision uint64
	value    T
	set      bool
}

type instanceState struct {
	id         InstanceID
	generation uint64
	health     observation[Health]
	weight     observation[uint32]
	drain      observation[DrainState]
	membership observation[bool]
}

func (s *instanceState) reset(generation uint64) {
	*s = instanceState{
		id:         s.id,
		generation: generation,
	}
}

func (s *instanceState) healthValue() Health {
	if !s.health.set {
		return HealthUnknown
	}
	return s.health.value
}

func (s *instanceState) weightValue(defaultWeight uint32) uint32 {
	if !s.weight.set {
		return defaultWeight
	}
	return s.weight.value
}

func (s *instanceState) drainValue() DrainState {
	if !s.drain.set {
		return DrainActive
	}
	return s.drain.value
}

func (s *instanceState) isPresent() bool {
	if !s.membership.set {
		return true
	}
	return s.membership.value
}

func (s *instanceState) isLive() bool {
	return s.isPresent() && s.drainValue() != DrainDrained
}

func (s *instanceState) isAvailable(defaultWeight uint32) bool {
	return s.isLive() &&
		s.healthValue() == HealthHealthy &&
		s.drainValue() == DrainActive &&
		s.weightValue(defaultWeight) > 0
}

func (s *instanceState) view(defaultWeight uint32) Instance {
	return Instance{
		ID:         s.id,
		Generation: s.generation,
		Health:     s.healthValue(),
		Weight:     s.weightValue(defaultWeight),
		Drain:      s.drainValue(),
		Available:  s.isAvailable(defaultWeight),
	}
}

// shouldReplace implements deterministic last-writer-wins. On equal
// revisions, a larger rank wins; this makes malformed conflicting duplicates
// converge to the same state in every arrival order.
func shouldReplace[T any](obs observation[T], revision uint64, rank uint64, oldRank uint64) bool {
	if !obs.set {
		return true
	}
	if revision != obs.revision {
		return revision > obs.revision
	}
	return rank > oldRank
}

func healthRank(h Health) uint64 {
	return uint64(h)
}

func weightRank(w uint32) uint64 {
	return uint64(w)
}

func drainRank(d DrainState) uint64 {
	return uint64(d)
}

func membershipRank(present bool) uint64 {
	if present {
		return 0
	}
	return 1
}

func (a *Aggregator) initLocked() {
	if a.instances == nil {
		a.instances = make(map[InstanceID]*instanceState)
	}
	if !a.weightReady {
		a.defaultWeight = 1
		a.weightReady = true
	}
}

func (a *Aggregator) effectiveDefaultWeight() uint32 {
	if !a.weightReady {
		return 1
	}
	return a.defaultWeight
}

// Apply folds one observation into the table.
//
// Invalid events return an error and do not change the table. A valid event
// that is stale or an exact duplicate returns ResultIgnored.
func (a *Aggregator) Apply(event Event) (ApplyResult, error) {
	if err := event.Validate(); err != nil {
		return ResultIgnored, err
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	a.initLocked()

	state, ok := a.instances[event.ID]
	if !ok {
		state = &instanceState{id: event.ID, generation: event.Generation}
		a.instances[event.ID] = state
	} else if event.Generation < state.generation {
		a.ignored++
		return ResultIgnored, nil
	} else if event.Generation > state.generation {
		state.reset(event.Generation)
	}

	applied := false
	switch event.Kind {
	case EventHealth:
		oldRank := healthRank(state.health.value)
		if shouldReplace(state.health, event.Revision, healthRank(event.Health), oldRank) {
			state.health = observation[Health]{
				revision: event.Revision,
				value:    event.Health,
				set:      true,
			}
			applied = true
		}
	case EventWeight:
		oldRank := weightRank(state.weight.value)
		if shouldReplace(state.weight, event.Revision, weightRank(event.Weight), oldRank) {
			state.weight = observation[uint32]{
				revision: event.Revision,
				value:    event.Weight,
				set:      true,
			}
			applied = true
		}
	case EventDrain:
		oldRank := drainRank(state.drain.value)
		if shouldReplace(state.drain, event.Revision, drainRank(event.Drain), oldRank) {
			state.drain = observation[DrainState]{
				revision: event.Revision,
				value:    event.Drain,
				set:      true,
			}
			applied = true
		}
	case EventAdd:
		oldRank := membershipRank(state.membership.value)
		if shouldReplace(state.membership, event.Revision, membershipRank(true), oldRank) {
			state.membership = observation[bool]{
				revision: event.Revision,
				value:    true,
				set:      true,
			}
			applied = true
		}
	case EventRemove:
		oldRank := membershipRank(state.membership.value)
		if shouldReplace(state.membership, event.Revision, membershipRank(false), oldRank) {
			state.membership = observation[bool]{
				revision: event.Revision,
				value:    false,
				set:      true,
			}
			applied = true
		}
	}

	if !applied {
		a.ignored++
		return ResultIgnored, nil
	}
	a.applied++
	return ResultApplied, nil
}

func (a *Aggregator) viewsLocked(availableOnly bool) []Instance {
	defaultWeight := a.effectiveDefaultWeight()
	views := make([]Instance, 0, len(a.instances))
	for _, state := range a.instances {
		if !state.isLive() {
			continue
		}
		view := state.view(defaultWeight)
		if availableOnly && !view.Available {
			continue
		}
		views = append(views, view)
	}
	sort.Slice(views, func(i, j int) bool {
		return views[i].ID < views[j].ID
	})
	return views
}

// Snapshot returns the live instances, sorted by ID.
//
// Draining instances are included with their drain state; drained and removed
// instances are omitted.
func (a *Aggregator) Snapshot() []Instance {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.viewsLocked(false)
}

// Available returns the instances eligible for new requests, sorted by ID.
//
// An instance is eligible when it is live, healthy, not draining, and has a
// positive weight.
func (a *Aggregator) Available() []Instance {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.viewsLocked(true)
}

// Lookup returns one live instance.
func (a *Aggregator) Lookup(id InstanceID) (Instance, bool) {
	a.mu.RLock()
	defer a.mu.RUnlock()

	state, ok := a.instances[id]
	if !ok || !state.isLive() {
		return Instance{}, false
	}
	return state.view(a.effectiveDefaultWeight()), true
}

// Select picks an available instance deterministically from selector. The
// selection is weighted by each instance's current weight.
func (a *Aggregator) Select(selector uint64) (InstanceID, bool) {
	a.mu.RLock()
	defer a.mu.RUnlock()

	defaultWeight := a.effectiveDefaultWeight()
	type candidate struct {
		id     InstanceID
		weight uint64
	}
	candidates := make([]candidate, 0, len(a.instances))
	var total uint64
	for _, state := range a.instances {
		if !state.isAvailable(defaultWeight) {
			continue
		}
		weight := uint64(state.weightValue(defaultWeight))
		candidates = append(candidates, candidate{id: state.id, weight: weight})
		total += weight
	}
	if total == 0 {
		return "", false
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].id < candidates[j].id
	})

	offset := selector % total
	for _, candidate := range candidates {
		if offset < candidate.weight {
			return candidate.id, true
		}
		offset -= candidate.weight
	}

	// The loop above is exhaustive because offset < total and candidate
	// weights sum to total.
	return "", false
}

// Pick selects an available instance using rnd. A nil rnd behaves like
// Select(0).
func (a *Aggregator) Pick(rnd *rand.Rand) (InstanceID, bool) {
	if rnd == nil {
		return a.Select(0)
	}
	return a.Select(rnd.Uint64())
}

// TotalWeight returns the sum of the weights of all available instances.
func (a *Aggregator) TotalWeight() uint64 {
	a.mu.RLock()
	defer a.mu.RUnlock()

	defaultWeight := a.effectiveDefaultWeight()
	var total uint64
	for _, state := range a.instances {
		if state.isAvailable(defaultWeight) {
			total += uint64(state.weightValue(defaultWeight))
		}
	}
	return total
}

// Len returns the number of live instances.
func (a *Aggregator) Len() int {
	a.mu.RLock()
	defer a.mu.RUnlock()

	count := 0
	for _, state := range a.instances {
		if state.isLive() {
			count++
		}
	}
	return count
}

// Stats is a point-in-time summary of an Aggregator.
type Stats struct {
	LiveInstances      int
	AvailableInstances int
	TotalWeight        uint64
	Applied            uint64
	Ignored            uint64
}

// Stats returns counters and a summary of the current table.
func (a *Aggregator) Stats() Stats {
	a.mu.RLock()
	defer a.mu.RUnlock()

	defaultWeight := a.effectiveDefaultWeight()
	stats := Stats{
		Applied: a.applied,
		Ignored: a.ignored,
	}
	for _, state := range a.instances {
		if !state.isLive() {
			continue
		}
		stats.LiveInstances++
		if state.isAvailable(defaultWeight) {
			stats.AvailableInstances++
			stats.TotalWeight += uint64(state.weightValue(defaultWeight))
		}
	}
	return stats
}
