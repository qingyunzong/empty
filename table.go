package dataeng

import (
	"errors"
	"fmt"
	"reflect"
	"sort"
	"sync"
	"time"
)

var (
	// ErrSameStartConflict is returned when a dimension change has the same
	// ValidFrom as an already committed version but is not an exact duplicate.
	// The incoming change is quarantined and the committed table is unchanged.
	ErrSameStartConflict = errors.New("dataeng: dimension version conflicts at the same valid_from")

	// ErrConflict is kept as a short alias for ErrSameStartConflict.
	ErrConflict = ErrSameStartConflict

	// ErrInvalidSnapshot is returned when a serialized table snapshot violates
	// the version ordering or non-overlap invariants.
	ErrInvalidSnapshot = errors.New("dataeng: invalid temporal table snapshot")
)

// DimensionChange is one version of a dimension row as emitted by a source
// changelog. ValidFrom is event time, not ingestion time. SourceSequence is the
// monotonic sequence/LSN from the source and makes replays idempotent.
type DimensionChange struct {
	Key            string    `json:"key"`
	ValidFrom      time.Time `json:"valid_from"`
	SourceSequence uint64    `json:"source_sequence"`
	Value          any       `json:"value,omitempty"`
}

// Dimension is an alias for DimensionChange.
type Dimension = DimensionChange

// DimensionRecord is an alias for DimensionChange.
type DimensionRecord = DimensionChange

// DimensionRow is an alias for DimensionChange.
type DimensionRow = DimensionChange

// Version is a stored, non-overlapping dimension version. ValidTo is the start
// of the next version and is zero for the currently open-ended version.
type Version struct {
	Key            string    `json:"key"`
	ValidFrom      time.Time `json:"valid_from"`
	SourceSequence uint64    `json:"source_sequence"`
	Value          any       `json:"value,omitempty"`
	ValidTo        time.Time `json:"valid_to,omitempty"`
	OpenEnded      bool      `json:"open_ended,omitempty"`
}

// DimensionVersion is an alias for Version.
type DimensionVersion = Version

// Contains reports whether t is in this version's half-open interval.
func (v Version) Contains(t time.Time) bool {
	if t.Before(v.ValidFrom) {
		return false
	}
	return v.OpenEnded || v.ValidTo.IsZero() || t.Before(v.ValidTo)
}

// SameVersion reports whether two versions describe the same source change.
// Time instants are compared with Time.Equal so decoding a timestamp through a
// different location does not create a false conflict.
func SameVersion(a, b Version) bool {
	return a.Key == b.Key &&
		a.ValidFrom.Equal(b.ValidFrom) &&
		a.SourceSequence == b.SourceSequence &&
		reflect.DeepEqual(a.Value, b.Value)
}

// ApplyOutcome describes what happened to a dimension change.
type ApplyOutcome int

const (
	// OutcomeApplied means the change was inserted.
	OutcomeApplied ApplyOutcome = iota
	// OutcomeDuplicate means the exact change was already present.
	OutcomeDuplicate
	// OutcomeConflict means the change was quarantined.
	OutcomeConflict
)

func (o ApplyOutcome) String() string {
	switch o {
	case OutcomeApplied:
		return "applied"
	case OutcomeDuplicate:
		return "duplicate"
	case OutcomeConflict:
		return "conflict"
	default:
		return fmt.Sprintf("ApplyOutcome(%d)", int(o))
	}
}

// SameStartPolicy controls what happens when a change has the same ValidFrom
// as a committed version.
//
// QuarantineSameStart is the safe default required by the temporal join
// contract: a different version at the same start is never allowed to make the
// version intervals ambiguous. LatestSequenceWins is available for sources
// that guarantee one authoritative sequence per ValidFrom; the superseded
// record is still kept in the conflict log.
type SameStartPolicy int

const (
	QuarantineSameStart SameStartPolicy = iota
	LatestSequenceWins
)

// Conflict is a quarantined dimension change. It is never part of Lookup.
type Conflict struct {
	Key            string          `json:"key"`
	ValidFrom      time.Time       `json:"valid_from"`
	SourceSequence uint64          `json:"source_sequence"`
	Incoming       DimensionChange `json:"incoming"`
	Incumbent      Version         `json:"incumbent"`
	Reason         string          `json:"reason"`
}

// Error implements error for callers that collect conflicts as values.
func (c Conflict) Error() string {
	return fmt.Sprintf("%s: key=%q valid_from=%s source_sequence=%d: %s",
		ErrSameStartConflict, c.Key, c.ValidFrom.Format(time.RFC3339Nano),
		c.SourceSequence, c.Reason)
}

// VersionConflict is an alias for Conflict.
type VersionConflict = Conflict

// Table stores all dimension versions. It is safe for concurrent use.
type Table struct {
	mu        sync.RWMutex
	versions  map[string][]Version
	conflicts []Conflict
	sameStart SameStartPolicy
}

// TemporalTable is an alias for Table.
type TemporalTable = Table

// VersionedTable is an alias for Table.
type VersionedTable = Table

// NewTable returns an empty temporal table using QuarantineSameStart.
func NewTable() *Table {
	return &Table{versions: make(map[string][]Version)}
}

// NewTemporalTable is an alias for NewTable.
func NewTemporalTable() *Table { return NewTable() }

// NewVersionedTable is an alias for NewTable.
func NewVersionedTable() *Table { return NewTable() }

// NewTableWithPolicy returns an empty temporal table with an explicit
// same-start policy.
func NewTableWithPolicy(policy SameStartPolicy) *Table {
	return &Table{versions: make(map[string][]Version), sameStart: policy}
}

// SetSameStartPolicy changes the policy used for future changes. Existing
// versions and conflicts are not changed.
func (t *Table) SetSameStartPolicy(policy SameStartPolicy) {
	t.mu.Lock()
	t.sameStart = policy
	t.mu.Unlock()
}

// SameStartPolicy returns the current same-start policy.
func (t *Table) SameStartPolicy() SameStartPolicy {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.sameStart
}

// Apply inserts one dimension change. It returns nil for both a new version and
// an exact duplicate (replay), and ErrSameStartConflict for a quarantined
// change. Conflicts can be inspected with Conflicts or TakeConflicts.
func (t *Table) Apply(change DimensionChange) error {
	_, err := t.Upsert(change)
	return err
}

// Add is an alias for Apply.
func (t *Table) Add(change DimensionChange) error { return t.Apply(change) }

// Insert is an alias for Apply.
func (t *Table) Insert(change DimensionChange) error { return t.Apply(change) }

// ApplyBatch applies changes in order. It stops at the first conflict. Changes
// already applied are retained.
func (t *Table) ApplyBatch(changes []DimensionChange) error {
	for _, change := range changes {
		if err := t.Apply(change); err != nil {
			return err
		}
	}
	return nil
}

// Upsert inserts a change and reports whether it was applied, was an exact
// replay, or was quarantined.
func (t *Table) Upsert(change DimensionChange) (ApplyOutcome, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	change = cloneChange(change)
	versions := t.versions[change.Key]
	idx := sort.Search(len(versions), func(i int) bool {
		return !versions[i].ValidFrom.Before(change.ValidFrom)
	})

	if idx < len(versions) && versions[idx].ValidFrom.Equal(change.ValidFrom) {
		incumbent := versions[idx]
		if SameVersion(incumbent, Version{
			Key:            change.Key,
			ValidFrom:      change.ValidFrom,
			SourceSequence: change.SourceSequence,
			Value:          change.Value,
		}) {
			return OutcomeDuplicate, nil
		}
		if reflect.DeepEqual(incumbent.Value, change.Value) {
			// A no-op replay may be observed under a different source sequence.
			// There is no conflicting payload, so keep one version and retain
			// the highest sequence for deterministic provenance.
			if change.SourceSequence > incumbent.SourceSequence {
				versions[idx].SourceSequence = change.SourceSequence
			}
			return OutcomeDuplicate, nil
		}

		if t.sameStart == LatestSequenceWins &&
			change.SourceSequence > incumbent.SourceSequence {
			// The source sequence establishes a deterministic replacement. The
			// old record is retained in quarantine for auditability.
			t.conflicts = append(t.conflicts, newConflict(change,
				t.copyVersionAtLocked(versions, idx),
				"superseded by a higher source_sequence at the same valid_from"))
			versions[idx].SourceSequence = change.SourceSequence
			versions[idx].Value = cloneValue(change.Value)
			t.versions[change.Key] = versions
			return OutcomeApplied, nil
		}

		reason := "different change already committed at this valid_from"
		if change.SourceSequence == incumbent.SourceSequence {
			reason = "same valid_from and source_sequence with a different value"
		}
		t.conflicts = append(t.conflicts, newConflict(change,
			t.copyVersionAtLocked(versions, idx), reason))
		return OutcomeConflict, ErrSameStartConflict
	}

	versions = append(versions, Version{})
	copy(versions[idx+1:], versions[idx:])
	versions[idx] = Version{
		Key:            change.Key,
		ValidFrom:      change.ValidFrom,
		SourceSequence: change.SourceSequence,
		Value:          cloneValue(change.Value),
	}
	t.versions[change.Key] = versions
	return OutcomeApplied, nil
}

func newConflict(incoming DimensionChange, incumbent Version, reason string) Conflict {
	return Conflict{
		Key:            incoming.Key,
		ValidFrom:      incoming.ValidFrom,
		SourceSequence: incoming.SourceSequence,
		Incoming:       cloneChange(incoming),
		Incumbent:      copyVersion(incumbent, incumbent.ValidTo),
		Reason:         reason,
	}
}

// Lookup returns the version in effect at at. The returned Version is a copy
// and has ValidTo populated from the following version.
func (t *Table) Lookup(key string, at time.Time) (Version, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()

	versions := t.versions[key]
	idx := sort.Search(len(versions), func(i int) bool {
		return versions[i].ValidFrom.After(at)
	})
	if idx == 0 {
		return Version{}, false
	}
	idx--
	return t.copyVersionAtLocked(versions, idx), true
}

// Get is an alias for Lookup.
func (t *Table) Get(key string, at time.Time) (Version, bool) { return t.Lookup(key, at) }

// At is an alias for Lookup.
func (t *Table) At(key string, at time.Time) (Version, bool) { return t.Lookup(key, at) }

// Resolve is an alias for Lookup.
func (t *Table) Resolve(key string, at time.Time) (Version, bool) { return t.Lookup(key, at) }

// LookupValue returns only the payload of the version in effect at at.
func (t *Table) LookupValue(key string, at time.Time) (any, bool) {
	v, ok := t.Lookup(key, at)
	if !ok {
		return nil, false
	}
	return v.Value, true
}

// Versions returns a copy of all versions for a key in ValidFrom order.
func (t *Table) Versions(key string) []Version {
	t.mu.RLock()
	defer t.mu.RUnlock()

	versions := t.versions[key]
	out := make([]Version, len(versions))
	for i := range versions {
		out[i] = t.copyVersionAtLocked(versions, i)
	}
	return out
}

// History is an alias for Versions.
func (t *Table) History(key string) []Version { return t.Versions(key) }

func (t *Table) copyVersionAtLocked(versions []Version, idx int) Version {
	var validTo time.Time
	if idx+1 < len(versions) {
		validTo = versions[idx+1].ValidFrom
	}
	return copyVersion(versions[idx], validTo)
}

func copyVersion(v Version, validTo time.Time) Version {
	v.Value = cloneValue(v.Value)
	v.ValidTo = validTo
	v.OpenEnded = validTo.IsZero()
	return v
}

// Keys returns dimension keys in stable sorted order.
func (t *Table) Keys() []string {
	t.mu.RLock()
	defer t.mu.RUnlock()

	keys := make([]string, 0, len(t.versions))
	for key := range t.versions {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// Conflicts returns a copy of all quarantined changes in arrival order.
func (t *Table) Conflicts() []Conflict {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return cloneConflicts(t.conflicts)
}

// TakeConflicts returns and clears the quarantine list.
func (t *Table) TakeConflicts() []Conflict {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := cloneConflicts(t.conflicts)
	t.conflicts = nil
	return out
}

// ClearConflicts removes quarantined changes without returning them.
func (t *Table) ClearConflicts() {
	t.mu.Lock()
	t.conflicts = nil
	t.mu.Unlock()
}

// Compact merges adjacent versions whose payloads are identical. Since the
// versions being merged have identical payloads, every as-of lookup returns
// exactly the same value after compaction. It returns the number of version
// records removed.
func (t *Table) Compact() int {
	t.mu.Lock()
	defer t.mu.Unlock()

	removed := 0
	for key, versions := range t.versions {
		if len(versions) < 2 {
			continue
		}
		out := make([]Version, 0, len(versions))
		for _, v := range versions {
			if len(out) > 0 && reflect.DeepEqual(out[len(out)-1].Value, v.Value) {
				removed++
				continue
			}
			out = append(out, v)
		}
		t.versions[key] = out
	}
	return removed
}

// TableSnapshot is a JSON-friendly copy of a table.
type TableSnapshot struct {
	Versions  map[string][]Version `json:"versions"`
	Conflicts []Conflict           `json:"conflicts,omitempty"`
	Policy    SameStartPolicy      `json:"same_start_policy,omitempty"`
}

// Snapshot returns a deep copy of the table.
func (t *Table) Snapshot() TableSnapshot {
	t.mu.RLock()
	defer t.mu.RUnlock()

	snap := TableSnapshot{
		Versions:  make(map[string][]Version, len(t.versions)),
		Conflicts: cloneConflicts(t.conflicts),
		Policy:    t.sameStart,
	}
	for key, versions := range t.versions {
		cp := make([]Version, len(versions))
		for i := range versions {
			cp[i] = copyVersion(versions[i], time.Time{})
			cp[i].ValidTo = time.Time{}
			cp[i].OpenEnded = false
		}
		snap.Versions[key] = cp
	}
	return snap
}

// Load replaces the table with a snapshot. The snapshot is validated before
// any state is changed.
func (t *Table) Load(snap TableSnapshot) error {
	versions := make(map[string][]Version, len(snap.Versions))
	for key, rows := range snap.Versions {
		cp := make([]Version, len(rows))
		for i, row := range rows {
			if row.Key != "" && row.Key != key {
				return fmt.Errorf("%w: version key %q stored under %q",
					ErrInvalidSnapshot, row.Key, key)
			}
			row.Key = key
			row.ValidTo = time.Time{}
			row.OpenEnded = false
			row.Value = cloneValue(row.Value)
			cp[i] = row
			if i > 0 && !cp[i-1].ValidFrom.Before(cp[i].ValidFrom) {
				return fmt.Errorf("%w: key %q has duplicate or unsorted valid_from at index %d",
					ErrInvalidSnapshot, key, i)
			}
		}
		versions[key] = cp
	}

	t.mu.Lock()
	t.versions = versions
	t.conflicts = cloneConflicts(snap.Conflicts)
	t.sameStart = snap.Policy
	t.mu.Unlock()
	return nil
}

// Clone returns an independent copy of the table.
func (t *Table) Clone() *Table {
	snap := t.Snapshot()
	out := NewTableWithPolicy(snap.Policy)
	_ = out.Load(snap)
	return out
}

func cloneChange(c DimensionChange) DimensionChange {
	c.Value = cloneValue(c.Value)
	return c
}

func cloneConflicts(in []Conflict) []Conflict {
	out := make([]Conflict, len(in))
	for i, c := range in {
		c.Incoming = cloneChange(c.Incoming)
		c.Incumbent = copyVersion(c.Incumbent, c.Incumbent.ValidTo)
		out[i] = c
	}
	return out
}

// cloneValue copies the common mutable pipeline payload types. Scalar and
// struct values are immutable from the table's point of view and are returned
// unchanged.
func cloneValue(v any) any {
	if v == nil {
		return nil
	}
	return cloneReflect(reflect.ValueOf(v)).Interface()
}

func cloneReflect(rv reflect.Value) reflect.Value {
	if !rv.IsValid() {
		return rv
	}
	switch rv.Kind() {
	case reflect.Interface:
		if rv.IsNil() {
			return rv
		}
		inner := cloneReflect(rv.Elem())
		out := reflect.New(rv.Type()).Elem()
		if inner.IsValid() && inner.Type().AssignableTo(rv.Type()) {
			out.Set(inner)
		} else {
			out.Set(rv)
		}
		return out
	case reflect.Map:
		if rv.IsNil() {
			return rv
		}
		out := reflect.MakeMapWithSize(rv.Type(), rv.Len())
		iter := rv.MapRange()
		for iter.Next() {
			// Map keys define identity; copying them would break lookup by the
			// original key for pointer-valued keys. Only payload values are
			// deep-copied.
			key := iter.Key()
			value := cloneReflect(iter.Value())
			if !value.Type().AssignableTo(rv.Type().Elem()) {
				value = iter.Value()
			}
			out.SetMapIndex(key, value)
		}
		return out
	case reflect.Slice:
		if rv.IsNil() {
			return rv
		}
		out := reflect.MakeSlice(rv.Type(), rv.Len(), rv.Len())
		for i := 0; i < rv.Len(); i++ {
			value := cloneReflect(rv.Index(i))
			if value.Type().AssignableTo(rv.Type().Elem()) {
				out.Index(i).Set(value)
			} else {
				out.Index(i).Set(rv.Index(i))
			}
		}
		return out
	case reflect.Array:
		out := reflect.New(rv.Type()).Elem()
		out.Set(rv)
		for i := 0; i < rv.Len(); i++ {
			value := cloneReflect(rv.Index(i))
			if value.Type().AssignableTo(rv.Type().Elem()) {
				out.Index(i).Set(value)
			}
		}
		return out
	case reflect.Pointer:
		if rv.IsNil() {
			return rv
		}
		out := reflect.New(rv.Type().Elem())
		value := cloneReflect(rv.Elem())
		if value.Type().AssignableTo(rv.Type().Elem()) {
			out.Elem().Set(value)
		} else {
			out.Elem().Set(rv.Elem())
		}
		return out
	default:
		return rv
	}
}
