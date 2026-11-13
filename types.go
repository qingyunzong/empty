package dataeng

import "time"

// VersionKind distinguishes live feature values from deletion markers.
type VersionKind int8

const (
	// KindUpsert is a normal feature value version.
	KindUpsert VersionKind = iota
	// KindTombstone marks that the feature was deleted as of its event time.
	KindTombstone
)

// FeatureVersion is one immutable version of a feature value.
//
// EventTime is the business time at which the value became effective.
// CreatedTime is the platform ingestion time; it bounds what was knowable at
// the training snapshot so late backfills cannot leak into training.
// SourceSequence orders versions that share the same EventTime.
// TTL, when positive, expires the version EventTime+TTL after EventTime;
// zero means the Joiner default applies. TTL never applies to tombstones.
type FeatureVersion[K comparable, V any] struct {
	Key            K
	EventTime      time.Time
	CreatedTime    time.Time
	SourceSequence int64
	Kind           VersionKind
	Value          V
	TTL            time.Duration
}

// IsTombstone reports whether the version is a deletion marker.
func (v FeatureVersion[K, V]) IsTombstone() bool {
	return v.Kind == KindTombstone
}

// Upsert builds a live feature value version.
func Upsert[K comparable, V any](key K, eventTime, createdTime time.Time, sourceSequence int64, value V, ttl time.Duration) FeatureVersion[K, V] {
	return FeatureVersion[K, V]{
		Key:            key,
		EventTime:      eventTime,
		CreatedTime:    createdTime,
		SourceSequence: sourceSequence,
		Kind:           KindUpsert,
		Value:          value,
		TTL:            ttl,
	}
}

// Tombstone builds a deletion marker effective as of eventTime.
func Tombstone[K comparable, V any](key K, eventTime, createdTime time.Time, sourceSequence int64) FeatureVersion[K, V] {
	return FeatureVersion[K, V]{
		Key:            key,
		EventTime:      eventTime,
		CreatedTime:    createdTime,
		SourceSequence: sourceSequence,
		Kind:           KindTombstone,
	}
}

// Fact is one training observation asking for a feature as-of two clocks.
type Fact[K comparable] struct {
	Key          K
	EventTime    time.Time
	SnapshotTime time.Time
}

// State is the point-in-time join outcome for one fact.
type State int8

const (
	// StateAbsent means no eligible live version exists as-of the fact.
	StateAbsent State = iota
	// StatePresent means a live value was selected.
	StatePresent
	// StateTombstoned means an eligible deletion marker was selected.
	StateTombstoned
)

// Reason explains why a fact has no present value.
type Reason int8

const (
	// ReasonNone is set when a value is present.
	ReasonNone Reason = iota
	// ReasonNoVersion means the store holds no version for the key.
	ReasonNoVersion
	// ReasonNoEligibleVersion means every version violates the event-time or
	// created-time bounds.
	ReasonNoEligibleVersion
	// ReasonTTLExpired means every time-eligible live version exceeded its TTL.
	ReasonTTLExpired
)

// Result is the point-in-time join outcome for one fact.
type Result[K comparable, V any] struct {
	// State is the overall outcome.
	State State
	// Reason details an absent outcome; ReasonNone otherwise.
	Reason Reason
	// Value is the selected feature value, zero when not present.
	Value V
	// Selected is the winning version (live value or tombstone), nil when absent.
	Selected *FeatureVersion[K, V]
}

// Found reports whether a live value was selected.
func (r Result[K, V]) Found() bool {
	return r.State == StatePresent
}
