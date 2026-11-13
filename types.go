package dataeng

import "time"

// EventType describes the mutation carried by an event or snapshot.
type EventType string

const (
	EventUpsert EventType = "upsert"
	EventDelete EventType = "delete"
)

// Event is a single webhook delivery for a resource.
type Event struct {
	ID         string    `json:"id"`
	ResourceID string    `json:"resource_id"`
	Version    uint64    `json:"version"`
	IssuedAt   time.Time `json:"issued_at"`
	Type       EventType `json:"type"`
	Payload    []byte    `json:"payload,omitempty"`
}

// Snapshot is a backfill response: the resource state as of Version.
type Snapshot struct {
	ResourceID string    `json:"resource_id"`
	Version    uint64    `json:"version"`
	Type       EventType `json:"type"`
	Payload    []byte    `json:"payload,omitempty"`
}

// BackfillRequest asks the upstream SaaS API for a snapshot covering the
// versions missed between the last applied version and the highest observed.
type BackfillRequest struct {
	ResourceID string `json:"resource_id"`
	// FromVersion is the last contiguously applied version (exclusive).
	FromVersion uint64 `json:"from_version"`
	// ToVersion is the highest version observed so far (inclusive).
	ToVersion uint64 `json:"to_version"`
}

// OutboundRecord is one entry of the merged, deduplicated output stream.
// Seq is monotonically increasing and stable across crash recovery.
type OutboundRecord struct {
	Seq        uint64    `json:"seq"`
	ResourceID string    `json:"resource_id"`
	Version    uint64    `json:"version"`
	Type       EventType `json:"type"`
	Payload    []byte    `json:"payload,omitempty"`
	EventID    string    `json:"event_id,omitempty"`
	Snapshot   bool      `json:"snapshot,omitempty"`
}
