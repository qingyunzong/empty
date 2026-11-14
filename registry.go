package dataeng

import (
	"fmt"
	"sort"
	"sync"
)

// RelationEntry is one schema version plus the LSN at which it became
// effective.
type RelationEntry struct {
	Relation     Relation `json:"relation"`
	EffectiveLSN LSN      `json:"effective_lsn"`
}

// RelationRegistry stores immutable relation schema versions. It never
// rewrites an existing version, which is what makes late-decoded old tuples
// safe to interpret.
type RelationRegistry struct {
	mu      sync.RWMutex
	entries map[uint32]map[uint32]RelationEntry
}

// NewRelationRegistry returns an empty registry.
func NewRelationRegistry() *RelationRegistry {
	return &RelationRegistry{entries: make(map[uint32]map[uint32]RelationEntry)}
}

// Add registers a relation version effective at effectiveLSN. Re-adding the
// exact same version is idempotent. A changed schema under an existing version
// is a hard error.
func (r *RelationRegistry) Add(relation Relation, effectiveLSN LSN) error {
	if r == nil {
		return fmt.Errorf("%w: nil registry", ErrInvalidRelation)
	}
	if err := relation.Validate(); err != nil {
		return err
	}
	if !effectiveLSN.IsValid() {
		return fmt.Errorf("%w: relation %d version %d has invalid effective LSN",
			ErrInvalidRelation, relation.ID, relation.Version)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.entries == nil {
		r.entries = make(map[uint32]map[uint32]RelationEntry)
	}
	versions := r.entries[relation.ID]
	if existing, exists := versions[relation.Version]; exists {
		if !existing.Relation.Equal(relation) || existing.EffectiveLSN != effectiveLSN {
			return fmt.Errorf("%w: relation %d version %d already exists with a different schema or LSN",
				ErrRelationVersionConflict, relation.ID, relation.Version)
		}
		return nil
	}
	var latest RelationEntry
	for _, entry := range versions {
		if entry.Relation.Version > latest.Relation.Version ||
			(entry.Relation.Version == latest.Relation.Version && entry.EffectiveLSN > latest.EffectiveLSN) {
			latest = entry
		}
	}
	if latest.Relation.Version != 0 {
		if relation.Version <= latest.Relation.Version {
			return fmt.Errorf("%w: relation %d version %d is not newer than version %d",
				ErrRelationVersionConflict, relation.ID, relation.Version, latest.Relation.Version)
		}
		if effectiveLSN < latest.EffectiveLSN {
			return fmt.Errorf("%w: relation %d version %d effective LSN %s precedes version %d at %s",
				ErrRelationVersionConflict, relation.ID, relation.Version, effectiveLSN,
				latest.Relation.Version, latest.EffectiveLSN)
		}
	}
	if versions == nil {
		versions = make(map[uint32]RelationEntry)
		r.entries[relation.ID] = versions
	}
	versions[relation.Version] = RelationEntry{
		Relation:     relation.Clone(),
		EffectiveLSN: effectiveLSN,
	}
	return nil
}

// Resolve returns the exact schema version. It never falls back to another
// version.
func (r *RelationRegistry) Resolve(relationID, version uint32) (Relation, LSN, bool) {
	if r == nil {
		return Relation{}, InvalidLSN, false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	versions, exists := r.entries[relationID]
	if !exists {
		return Relation{}, InvalidLSN, false
	}
	entry, exists := versions[version]
	if !exists {
		return Relation{}, InvalidLSN, false
	}
	return entry.Relation.Clone(), entry.EffectiveLSN, true
}

// EffectiveAt returns the newest version whose DDL is effective at or before
// lsn. It is intended for metadata lookup, not for decoding a tuple. Use
// Resolve for tuples.
func (r *RelationRegistry) EffectiveAt(relationID uint32, lsn LSN) (Relation, LSN, bool) {
	if r == nil {
		return Relation{}, InvalidLSN, false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	var best RelationEntry
	for _, entry := range r.entries[relationID] {
		if entry.EffectiveLSN > lsn {
			continue
		}
		if best.Relation.Version == 0 ||
			entry.EffectiveLSN > best.EffectiveLSN ||
			(entry.EffectiveLSN == best.EffectiveLSN && entry.Relation.Version > best.Relation.Version) {
			best = entry
		}
	}
	if best.Relation.Version == 0 {
		return Relation{}, InvalidLSN, false
	}
	return best.Relation.Clone(), best.EffectiveLSN, true
}

// Latest returns the newest registered version for a relation.
func (r *RelationRegistry) Latest(relationID uint32) (Relation, LSN, bool) {
	if r == nil {
		return Relation{}, InvalidLSN, false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	var best RelationEntry
	for _, entry := range r.entries[relationID] {
		if entry.Relation.Version > best.Relation.Version ||
			(entry.Relation.Version == best.Relation.Version && entry.EffectiveLSN > best.EffectiveLSN) {
			best = entry
		}
	}
	if best.Relation.Version == 0 {
		return Relation{}, InvalidLSN, false
	}
	return best.Relation.Clone(), best.EffectiveLSN, true
}

// Entries returns all registered versions sorted by relation ID and version.
func (r *RelationRegistry) Entries() []RelationEntry {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	count := 0
	for _, versions := range r.entries {
		count += len(versions)
	}
	entries := make([]RelationEntry, 0, count)
	for _, versions := range r.entries {
		for _, entry := range versions {
			entry.Relation = entry.Relation.Clone()
			entries = append(entries, entry)
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Relation.ID != entries[j].Relation.ID {
			return entries[i].Relation.ID < entries[j].Relation.ID
		}
		return entries[i].Relation.Version < entries[j].Relation.Version
	})
	return entries
}

// Clone returns an independent copy of the registry.
func (r *RelationRegistry) Clone() *RelationRegistry {
	clone := NewRelationRegistry()
	if r == nil {
		return clone
	}
	for _, entry := range r.Entries() {
		_ = clone.Add(entry.Relation, entry.EffectiveLSN)
	}
	return clone
}
