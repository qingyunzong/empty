package dataeng

import (
	"errors"
	"sort"
	"sync"
	"time"
)

var (
	// ErrEmptyKey is returned when a record or mutation omits the key.
	ErrEmptyKey = errors.New("dataeng: record key must not be empty")
	// ErrEmptyRegion is returned when a record or mutation omits the region.
	ErrEmptyRegion = errors.New("dataeng: region id must not be empty")
	// ErrEmptyVector is returned when a region record has no version vector.
	ErrEmptyVector = errors.New("dataeng: version vector must not be empty")
	// ErrMissingRegionVector is returned when the record's own region has no
	// counter entry in its version vector.
	ErrMissingRegionVector = errors.New("dataeng: version vector lacks the originating region")
	// ErrEmptyValue is returned when a live record carries no payload.
	ErrEmptyValue = errors.New("dataeng: non-tombstone record value must not be empty")
	// ErrNilSource is returned when Ingest/Replay receives a nil connector.
	ErrNilSource = errors.New("dataeng: region source must not be nil")
)

// keyState holds every retained version for one key. Versions that
// causally dominate others replace them; concurrent versions coexist as
// the conflict set.
type keyState struct {
	versions []Record
	// events deduplicates connector EventIDs for idempotent replay.
	events map[string]struct{}
}

// Store is a concurrency-safe, in-memory multi-region merge store.
// It never synthesizes deletions: missing data from an unreachable region
// leaves stored versions untouched.
type Store struct {
	mu   sync.RWMutex
	data map[string]*keyState
}

// New returns an empty merge store.
func New() *Store {
	return &Store{data: make(map[string]*keyState)}
}

// ApplyResult summarizes a single Apply call.
type ApplyResult struct {
	// Accepted indicates the record was newly retained.
	Accepted bool
	// Duplicate indicates the record was ignored because the same EventID
	// or an equal version vector had already been applied.
	Duplicate bool
	// Stale indicates the record was causally dominated by stored history.
	Stale bool
	// Conflicts is the number of concurrent versions retained for the key
	// after application, including the just-accepted record.
	Conflicts int
	// Alive reports whether the key currently resolves to a live (non-deleted)
	// value under its retained version set.
	Alive bool
}

// Apply ingests one region record using only its version vector for
// adjudication. It is safe for concurrent use and idempotent: replaying an
// already-seen EventID, or a record whose vector equals stored history, has
// no effect.
func (s *Store) Apply(rec Record) (ApplyResult, error) {
	if err := validate(rec); err != nil {
		return ApplyResult{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	return s.applyLocked(rec), nil
}

// ApplyBatch ingests multiple records. The batch is processed in deterministic
// (key, region, event) order so replay yields identical outcomes regardless of
// connector delivery order. All records are validated before any mutation.
func (s *Store) ApplyBatch(records []Record) ([]ApplyResult, error) {
	for _, rec := range records {
		if err := validate(rec); err != nil {
			return nil, err
		}
	}

	ordered := make([]Record, len(records))
	copy(ordered, records)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].Key != ordered[j].Key {
			return ordered[i].Key < ordered[j].Key
		}
		if ordered[i].Region != ordered[j].Region {
			return ordered[i].Region < ordered[j].Region
		}
		return ordered[i].EventID < ordered[j].EventID
	})

	s.mu.Lock()
	defer s.mu.Unlock()

	results := make([]ApplyResult, len(ordered))
	for i, rec := range ordered {
		results[i] = s.applyLocked(rec)
	}
	return results, nil
}

func (s *Store) applyLocked(rec Record) ApplyResult {
	state, ok := s.data[rec.Key]
	if !ok {
		state = &keyState{events: make(map[string]struct{})}
		s.data[rec.Key] = state
	}

	if rec.EventID != "" {
		if _, seen := state.events[rec.EventID]; seen {
			return ApplyResult{
				Duplicate: true,
				Conflicts: len(state.versions),
				Alive:     alive(state.versions),
			}
		}
	}

	// Compare against every retained version using the causal partial order.
	dominatedByExisting := false
	kept := make([]Record, 0, len(state.versions)+1)
	for _, existing := range state.versions {
		switch rec.Vector.Compare(existing.Vector) {
		case Before:
			// Stale: stored history causally dominates this record.
			dominatedByExisting = true
			kept = append(kept, existing)
		case Equal:
			// Same causal history: replaying the same version is idempotent.
			return ApplyResult{
				Duplicate: true,
				Conflicts: len(state.versions),
				Alive:     alive(state.versions),
			}
		case After:
			// The new record dominates this one; drop the older version.
			continue
		case Concurrent:
			kept = append(kept, existing)
		}
	}

	if dominatedByExisting {
		return ApplyResult{
			Stale:     true,
			Conflicts: len(kept),
			Alive:     alive(kept),
		}
	}

	kept = append(kept, rec.clone())
	state.versions = kept
	if rec.EventID != "" {
		state.events[rec.EventID] = struct{}{}
	}

	return ApplyResult{
		Accepted:  true,
		Conflicts: len(kept),
		Alive:     alive(kept),
	}
}

func validate(rec Record) error {
	if rec.Key == "" {
		return ErrEmptyKey
	}
	if rec.Region == "" {
		return ErrEmptyRegion
	}
	if len(rec.Vector) == 0 {
		return ErrEmptyVector
	}
	if _, ok := rec.Vector[rec.Region]; !ok {
		return ErrMissingRegionVector
	}
	if !rec.Tombstone && len(rec.Value) == 0 {
		return ErrEmptyValue
	}
	return nil
}

func alive(versions []Record) bool {
	for _, version := range versions {
		if !version.Tombstone {
			return true
		}
	}
	return false
}

// currentVectorLocked returns the component-wise maximum vector across the
// key's retained versions, used as the base for local mutations.
func (s *Store) currentVectorLocked(key string) VersionVector {
	state, ok := s.data[key]
	if !ok {
		return NewVersionVector()
	}
	current := NewVersionVector()
	for _, version := range state.versions {
		current = current.Merge(version.Vector)
	}
	return current
}

// Put applies a locally authored update from region. The region's counter is
// advanced on top of the key's current merged vector, so the new record
// causally dominates prior local history.
func (s *Store) Put(key, region string, value []byte, updatedAt time.Time, eventID string) (ApplyResult, error) {
	if key == "" {
		return ApplyResult{}, ErrEmptyKey
	}
	if region == "" {
		return ApplyResult{}, ErrEmptyRegion
	}
	if len(value) == 0 {
		return ApplyResult{}, ErrEmptyValue
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	vector := s.currentVectorLocked(key).Inc(region)
	rec := Record{
		Key:       key,
		Region:    region,
		Vector:    vector,
		Value:     append([]byte(nil), value...),
		UpdatedAt: updatedAt,
		EventID:   eventID,
	}
	return s.applyLocked(rec), nil
}

// Delete applies an explicit, tombstone-backed deletion from region.
// Tombstones are regular versioned records and therefore replicate and
// converge across regions. There is no way for an outage to produce one.
func (s *Store) Delete(key, region string, updatedAt time.Time, eventID string) (ApplyResult, error) {
	if key == "" {
		return ApplyResult{}, ErrEmptyKey
	}
	if region == "" {
		return ApplyResult{}, ErrEmptyRegion
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	vector := s.currentVectorLocked(key).Inc(region)
	rec := Record{
		Key:       key,
		Region:    region,
		Vector:    vector,
		Tombstone: true,
		UpdatedAt: updatedAt,
		EventID:   eventID,
	}
	return s.applyLocked(rec), nil
}

// Versions returns all retained versions for a key in stable insertion order.
// For a converged key this is a single record; for a concurrent conflict it
// is the full conflict set intended for policy handling.
func (s *Store) Versions(key string) ([]Record, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	state, ok := s.data[key]
	if !ok || len(state.versions) == 0 {
		return nil, false
	}
	out := make([]Record, len(state.versions))
	for i, version := range state.versions {
		out[i] = version.clone()
	}
	return out, true
}

// Effective returns the single effective record for a key. It returns false
// when the key is unknown or carries a concurrent conflict set that requires
// a ConflictPolicy to adjudicate.
func (s *Store) Effective(key string) (Record, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	state, ok := s.data[key]
	if !ok || len(state.versions) != 1 {
		return Record{}, false
	}
	return state.versions[0].clone(), true
}

// Lookup returns the effective payload for a live, non-conflicting key.
// Deleted, unknown and conflicting keys all report ok == false; use
// Versions plus a ConflictPolicy for the conflicting case.
func (s *Store) Lookup(key string) (value []byte, tombstone bool, ok bool) {
	rec, found := s.Effective(key)
	if !found {
		return nil, false, false
	}
	if rec.Tombstone {
		return nil, true, true
	}
	return append([]byte(nil), rec.Value...), false, true
}

// Keys returns all known keys, including tombstoned ones, in sorted order.
func (s *Store) Keys() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	keys := make([]string, 0, len(s.data))
	for key, state := range s.data {
		if len(state.versions) > 0 {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys
}

// Snapshot returns a deep copy of every retained version set, keyed by id.
func (s *Store) Snapshot() map[string][]Record {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := make(map[string][]Record, len(s.data))
	for key, state := range s.data {
		if len(state.versions) == 0 {
			continue
		}
		records := make([]Record, len(state.versions))
		for i, version := range state.versions {
			records[i] = version.clone()
		}
		out[key] = records
	}
	return out
}

// HasConflict reports whether the key currently retains a concurrent
// version set awaiting policy resolution.
func (s *Store) HasConflict(key string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	state, ok := s.data[key]
	return ok && len(state.versions) > 1
}
