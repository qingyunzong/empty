package dataeng

import "time"

// Record is a region-generated version of one key.
//
// Region records carry their own VersionVector, wall-clock UpdatedAt and an
// explicit Tombstone flag. UpdatedAt is metadata for display only and never
// influences merge adjudication. A deletion is represented by a record with
// Tombstone set, never by the absence of a record, so a temporarily
// unreachable region cannot be misread as a delete.
type Record struct {
	// Key identifies the merged entity, e.g. a global SaaS object id.
	Key string
	// Region is the originating region id; it must occur in Vector.
	Region string
	// Vector is the region's version vector for this record.
	Vector VersionVector
	// Value is the payload; ignored when Tombstone is true.
	Value []byte
	// Tombstone marks an explicit deletion.
	Tombstone bool
	// UpdatedAt is the wall-clock time for display purposes only.
	UpdatedAt time.Time
	// EventID is the connector's unique, stable event id used for
	// idempotent replay. When non-empty, re-applying the same event is a
	// no-op even before vector comparison runs.
	EventID string
}

func (r Record) clone() Record {
	clone := r
	if r.Vector != nil {
		clone.Vector = r.Vector.clone()
	}
	if r.Value != nil {
		clone.Value = append([]byte(nil), r.Value...)
	}
	return clone
}
