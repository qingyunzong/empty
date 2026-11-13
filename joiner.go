package dataeng

import "time"

// Joiner performs point-in-time joins between training facts and feature
// versions. The zero value is usable with no default TTL.
type Joiner[K comparable, V any] struct {
	store      FeatureStore[K, V]
	defaultTTL time.Duration
}

// Option configures a Joiner.
type Option[K comparable, V any] func(*Joiner[K, V])

// WithDefaultTTL sets the TTL used for versions whose own TTL is zero. A
// non-positive value means feature values never expire by default.
func WithDefaultTTL[K comparable, V any](ttl time.Duration) Option[K, V] {
	return func(j *Joiner[K, V]) {
		j.defaultTTL = ttl
	}
}

// NewJoiner builds a Joiner over the given store.
func NewJoiner[K comparable, V any](store FeatureStore[K, V], opts ...Option[K, V]) *Joiner[K, V] {
	j := &Joiner[K, V]{store: store}
	for _, opt := range opts {
		opt(j)
	}
	return j
}

// Join resolves every fact against the store, preserving input order. It
// returns the first store error encountered and no partial results.
func (j *Joiner[K, V]) Join(facts []Fact[K]) ([]Result[K, V], error) {
	results := make([]Result[K, V], len(facts))
	for i, fact := range facts {
		versions, err := j.store.Versions(fact.Key)
		if err != nil {
			return nil, err
		}
		results[i] = j.selectVersion(fact, versions)
	}
	return results, nil
}

func (j *Joiner[K, V]) selectVersion(fact Fact[K], versions []FeatureVersion[K, V]) Result[K, V] {
	result := Result[K, V]{}
	if len(versions) == 0 {
		result.Reason = ReasonNoVersion
		return result
	}

	sortVersions(versions)

	sawEligible := false
	sawExpired := false

	// Canonical order makes the first version surviving every guard the winner:
	// latest event time, highest source sequence on ties, latest created time.
	for i := range versions {
		version := &versions[i]

		// Future information guard: the value's business time must not be later
		// than the fact, and it must already exist at the training snapshot.
		if version.EventTime.After(fact.EventTime) || version.CreatedTime.After(fact.SnapshotTime) {
			continue
		}
		sawEligible = true

		if version.IsTombstone() {
			// Deletion markers do not expire: a tombstone permanently shadows
			// every older live version of the same key.
			result.State = StateTombstoned
			result.Selected = version
			return result
		}

		if j.expired(version, fact.EventTime) {
			sawExpired = true
			continue
		}

		result.State = StatePresent
		result.Selected = version
		result.Value = version.Value
		return result
	}

	switch {
	case !sawEligible:
		result.Reason = ReasonNoEligibleVersion
	case sawExpired:
		result.Reason = ReasonTTLExpired
	default:
		// Only possible when all eligible versions are tombstones, which is
		// handled above; keep a defensive fallback.
		result.Reason = ReasonNoEligibleVersion
	}
	return result
}

func (j *Joiner[K, V]) expired(version *FeatureVersion[K, V], asOf time.Time) bool {
	ttl := version.TTL
	if ttl <= 0 {
		ttl = j.defaultTTL
	}
	if ttl <= 0 {
		return false
	}
	return asOf.After(version.EventTime.Add(ttl))
}
