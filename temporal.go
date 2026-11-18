// Package formal implements a temporal lookup table for stream processing
// join operators.
//
// # Time model
//
// Every timestamp is an event-time scalar (for example milliseconds since
// the Unix epoch). A version of a primary key is visible on the half-open
// interval [ValidFrom, ValidTo): ValidFrom is inclusive and ValidTo is
// exclusive. An open-ended interval uses ValidTo == math.MaxInt64.
//
// A watermark is an event-time horizon. An event with timestamp t is on time
// while t >= watermark-allowedLateness (the boundary is inclusive); events
// strictly older than that horizon are dropped as too-late. An on-time
// version is visible to a probe only when its ValidFrom is not after the
// probe timestamp, so a version that becomes known later but carries a future
// ValidFrom is never selected before it takes effect.
//
// # Late events and retraction
//
// Accepted late writes and late probes stay inside the allowed-lateness
// window. They never mutate an already emitted output: corrections are
// appended to an append-only journal as new emissions (a tombstone produces a
// deletion emission that retracts the previous value). Historical emissions
// are therefore immutable and only supplemented by revisions.
package formal

import (
	"errors"
	"math"
	"sort"
	"sync"
)

// ErrInvalidTime is returned when a timestamp or interval endpoint is
// negative, or when ValidFrom is not strictly before ValidTo.
var ErrInvalidTime = errors.New("formal: invalid timestamp or version interval")

// Version is one point-in-time state of a primary key. Deleted is a tombstone:
// the key is known to be absent on [ValidFrom, ValidTo). A zero ValidTo marks
// an open-ended version with no expiration.
type Version[V any] struct {
	ValidFrom int64
	ValidTo   int64
	Value     V
	Deleted   bool
}

// Emission is one join output. Seq is the append-only position within the
// journal (0 for a probe's first emission, then 1, 2, ... for each revision).
// Deleted retracts the value of the probe's previous emission.
type Emission[V any] struct {
	Seq       int
	EventID   int64
	EventTime int64
	Key       int64
	Value     V
	Deleted   bool
}

type version[V any] struct {
	validFrom int64
	validTo   int64
	value     V
	deleted   bool
}

type tracked[V any] struct {
	eventID int64
	time    int64
	current Emission[V]
}

type keyState[V any] struct {
	versions []version[V]
	tracked  map[int64]tracked[V]
}

// horizonOf returns the oldest still-accepted event time for a watermark and
// an allowed-lateness gap. Before any watermark arrives every non-negative
// timestamp is accepted.
func horizonOf(watermark, allowedLateness int64) int64 {
	if watermark == math.MinInt64 {
		return 0
	}
	if allowedLateness < 0 {
		allowedLateness = 0
	}
	horizon := watermark - allowedLateness
	if watermark > 0 && horizon <= 0 {
		// Saturate on overflow: a maximal watermark accepts no further
		// historical events, so the horizon must remain the largest time.
		return math.MaxInt64
	}
	if horizon < 0 {
		return 0
	}
	return horizon
}

// LookupStore is a concurrent-safe temporal key/value table indexed by
// half-open validity intervals and an event-time watermark.
type LookupStore[V comparable] struct {
	mu              sync.RWMutex
	allowedLateness int64
	watermark       int64
	keys            map[int64]*keyState[V]
	pending         []Emission[V]
	journal         []Emission[V]
}

// NewLookupStore creates an empty table. Events up to allowedLateness time
// units behind the current watermark are still accepted as late events.
func NewLookupStore[V comparable](allowedLateness int64) *LookupStore[V] {
	if allowedLateness < 0 {
		allowedLateness = 0
	}
	return &LookupStore[V]{
		allowedLateness: allowedLateness,
		watermark:       math.MinInt64,
		keys:            make(map[int64]*keyState[V]),
	}
}

// AllowedLateness reports the configured lateness gap.
func (s *LookupStore[V]) AllowedLateness() int64 { return s.allowedLateness }

// Watermark reports the current watermark, or math.MinInt64 before the first
// advance.
func (s *LookupStore[V]) Watermark() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.watermark
}

// horizonLocked reports the oldest accepted event time under the current
// watermark.
func (s *LookupStore[V]) horizonLocked() int64 {
	return horizonOf(s.watermark, s.allowedLateness)
}

// validateWrites rejects negative timestamps and malformed intervals. A zero
// ValidTo denotes an open-ended interval and is rewritten to MaxInt64.
func validateWrites(from, to int64) error {
	if from < 0 || to < 0 || (to != 0 && from >= to) {
		return ErrInvalidTime
	}
	return nil
}

// Upsert inserts or replaces the version starting at validFrom for key. The
// inserted interval ends at the next existing ValidFrom, or stays open-ended
// when it is the newest version; the predecessor is closed at validFrom.
// Writes older than the lateness horizon are rejected and never change the
// table.
func (s *LookupStore[V]) Upsert(key int64, validFrom, validTo int64, value V) error {
	if err := validateWrites(validFrom, validTo); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if validFrom < s.horizonLocked() {
		return ErrInvalidTime
	}
	if validTo == 0 {
		validTo = math.MaxInt64
	}
	s.putVersion(key, version[V]{validFrom: validFrom, validTo: validTo, value: value})
	s.sweepLocked(key)
	return nil
}

// Delete writes a tombstone starting at validFrom, retracting the key under
// the same interval rules as Upsert.
func (s *LookupStore[V]) Delete(key int64, validFrom, validTo int64) error {
	var zero V
	if err := validateWrites(validFrom, validTo); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if validFrom < s.horizonLocked() {
		return ErrInvalidTime
	}
	if validTo == 0 {
		validTo = math.MaxInt64
	}
	s.putVersion(key, version[V]{validFrom: validFrom, validTo: validTo, value: zero, deleted: true})
	s.sweepLocked(key)
	return nil
}

// putVersion writes one version and restores the partition of time for the
// key: every interval stays half-open and intervals never overlap.
func (s *LookupStore[V]) putVersion(key int64, incoming version[V]) {
	st := s.keys[key]
	if st == nil {
		st = &keyState[V]{tracked: make(map[int64]tracked[V])}
		s.keys[key] = st
	}

	idx := sort.Search(len(st.versions), func(i int) bool {
		return st.versions[i].validFrom >= incoming.validFrom
	})

	if idx < len(st.versions) && st.versions[idx].validFrom == incoming.validFrom {
		// Replace the payload in place while preserving the established
		// interval; only the value or tombstone marker changes.
		st.versions[idx].value = incoming.value
		st.versions[idx].deleted = incoming.deleted
		return
	}

	st.versions = append(st.versions, version[V]{})
	copy(st.versions[idx+1:], st.versions[idx:])
	st.versions[idx] = incoming

	if idx > 0 {
		st.versions[idx-1].validTo = incoming.validFrom
	}
	if idx+1 < len(st.versions) {
		st.versions[idx].validTo = st.versions[idx+1].validFrom
	}
}

// Lookup returns the value visible for key at eventTime. The second result is
// false when the key is unknown at that time or its visible version is a
// tombstone. eventTime must be non-negative.
func (s *LookupStore[V]) Lookup(key int64, eventTime int64) (V, bool, error) {
	if eventTime < 0 {
		var zero V
		return zero, false, ErrInvalidTime
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lookupLocked(key, eventTime)
}

func (s *LookupStore[V]) lookupLocked(key int64, eventTime int64) (V, bool, error) {
	var zero V
	st := s.keys[key]
	if st == nil {
		return zero, false, nil
	}
	idx := sort.Search(len(st.versions), func(i int) bool {
		return st.versions[i].validFrom > eventTime
	}) - 1
	if idx < 0 {
		return zero, false, nil
	}
	ver := st.versions[idx]
	if eventTime < ver.validFrom || eventTime >= ver.validTo || ver.deleted {
		return zero, false, nil
	}
	return ver.value, true, nil
}

// Probe joins one event against the version visible at its event time and
// appends the output to the journal. A probe older than the lateness horizon
// is dropped: ok is false and nothing is emitted. Replaying the same eventID
// returns its stored emission without adding a duplicate.
func (s *LookupStore[V]) Probe(eventID int64, eventTime int64, key int64) (Emission[V], bool, error) {
	if eventTime < 0 {
		return Emission[V]{}, false, ErrInvalidTime
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	st := s.keys[key]
	if st != nil {
		if existing, ok := st.tracked[eventID]; ok {
			return existing.current, true, nil
		}
	}
	if eventTime < s.horizonLocked() {
		return Emission[V]{}, false, nil
	}

	value, found, err := s.lookupLocked(key, eventTime)
	if err != nil {
		return Emission[V]{}, false, err
	}
	em := Emission[V]{
		Seq:       len(s.journal),
		EventID:   eventID,
		EventTime: eventTime,
		Key:       key,
		Value:     value,
		Deleted:   !found,
	}
	if st == nil {
		st = &keyState[V]{tracked: make(map[int64]tracked[V])}
		s.keys[key] = st
	}
	st.tracked[eventID] = tracked[V]{eventID: eventID, time: eventTime, current: em}
	s.appendEmissionLocked(em)
	return em, true, nil
}

// Advance moves the watermark forward to w (regressions are ignored) and
// garbage-collects versions and tracked probes that no accepted event can
// observe anymore.
func (s *LookupStore[V]) Advance(w int64) error {
	if w < 0 {
		return ErrInvalidTime
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if w <= s.watermark {
		return nil
	}
	s.watermark = w
	horizon := s.horizonLocked()

	for key, st := range s.keys {
		kept := st.versions[:0]
		for _, ver := range st.versions {
			if ver.validTo > horizon {
				kept = append(kept, ver)
			}
		}
		st.versions = kept

		// Probes inside the allowed-lateness window stay tracked so late
		// writes can still revise them; probes below the horizon can no
		// longer be observed and are reclaimed.
		for id, probe := range st.tracked {
			if probe.time < horizon {
				delete(st.tracked, id)
			}
		}
		if len(st.versions) == 0 && len(st.tracked) == 0 {
			delete(s.keys, key)
		}
	}
	return nil
}

// Sweep drains and returns corrections produced by writes since the previous
// sweep, ordered by (event time, event id). The corrections were already
// appended to the journal; Sweep only hands the pending batch to the caller.
func (s *LookupStore[V]) Sweep() []Emission[V] {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.pending
	s.pending = nil
	return out
}

// Journal returns a copy of every emission in append order, including both
// original probe outputs and later revisions. Historical entries are never
// rewritten in place.
func (s *LookupStore[V]) Journal() []Emission[V] {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Emission[V], len(s.journal))
	copy(out, s.journal)
	return out
}

// appendEmissionLocked records one emission both as the next pending
// correction batch and as a permanent journal entry.
func (s *LookupStore[V]) appendEmissionLocked(em Emission[V]) {
	s.pending = append(s.pending, em)
	s.journal = append(s.journal, em)
}

// sweepLocked re-evaluates every tracked probe for one key after a write and
// appends a revision for each probe whose visible version changed.
func (s *LookupStore[V]) sweepLocked(key int64) {
	st := s.keys[key]
	if st == nil || len(st.tracked) == 0 {
		return
	}

	type probeRef struct {
		id int64
		tr tracked[V]
	}
	refs := make([]probeRef, 0, len(st.tracked))
	for id, tr := range st.tracked {
		refs = append(refs, probeRef{id: id, tr: tr})
	}
	sort.Slice(refs, func(i, j int) bool {
		if refs[i].tr.time != refs[j].tr.time {
			return refs[i].tr.time < refs[j].tr.time
		}
		return refs[i].id < refs[j].id
	})

	for _, ref := range refs {
		value, found, err := s.lookupLocked(key, ref.tr.time)
		if err != nil {
			continue
		}
		next := ref.tr.current
		if next.Deleted == !found && (found == false || next.Value == value) {
			continue
		}
		next.Seq = len(s.journal)
		next.Value = value
		next.Deleted = !found
		ref.tr.current = next
		st.tracked[ref.id] = ref.tr
		s.appendEmissionLocked(next)
	}
}

// debugVersions returns a defensive copy of the retained versions for a key.
// It exists for invariant tests and diagnostics rather than the join path.
func (s *LookupStore[V]) debugVersions(key int64) []Version[V] {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st := s.keys[key]
	if st == nil {
		return nil
	}
	out := make([]Version[V], len(st.versions))
	for i, ver := range st.versions {
		out[i] = Version[V]{
			ValidFrom: ver.validFrom,
			ValidTo:   ver.validTo,
			Value:     ver.value,
			Deleted:   ver.deleted,
		}
	}
	return out
}

// debugTracked reports how many probes for a key remain eligible for
// revision after watermark-driven garbage collection.
func (s *LookupStore[V]) debugTracked(key int64) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st := s.keys[key]
	if st == nil {
		return 0
	}
	return len(st.tracked)
}
