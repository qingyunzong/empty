package dataeng

import "time"

// Op is the kind of change an Event applies to an entity's unique key.
type Op int

const (
	// OpUpsert occupies the event's key for the entity, revoking any key the
	// entity previously held in the same generation.
	OpUpsert Op = iota
	// OpDelete revokes the key the entity currently holds without occupying
	// a new one.
	OpDelete
)

func (o Op) String() string {
	switch o {
	case OpUpsert:
		return "upsert"
	case OpDelete:
		return "delete"
	default:
		return "unknown"
	}
}

// Event is a single change observed by the streaming quality gate.
type Event struct {
	EntityID  string
	Key       string
	Op        Op
	EventTime time.Time
}

// Status is the verdict of applying one event.
type Status int

const (
	// StatusAccepted means the event occupied (or revoked) its key without
	// colliding with another entity.
	StatusAccepted Status = iota
	// StatusDuplicate means the event's normalized key is already occupied
	// by another entity in the same window and generation; the event joins
	// the key's conflict group.
	StatusDuplicate
	// StatusRejectedLate means the event fell outside the rule's allowed
	// lateness and was dropped without changing any state.
	StatusRejectedLate
)

func (s Status) String() string {
	switch s {
	case StatusAccepted:
		return "accepted"
	case StatusDuplicate:
		return "duplicate"
	case StatusRejectedLate:
		return "rejected-late"
	default:
		return "unknown"
	}
}

// Outcome describes the effect of applying one event.
type Outcome struct {
	Status Status
	RuleID string
	// Generation is the normalization generation the event was evaluated in.
	Generation int
	// NormalizedKey is the key after applying the rule's normalization.
	NormalizedKey string
	WindowStart   time.Time
	WindowEnd     time.Time
	// RevokedKey and RevokedWindow identify the occupancy this event undid
	// (an update's old key, or a delete's key), if any.
	RevokedKey    string
	RevokedWindow time.Time
	// Owner is the entity currently holding the key: the claim with the
	// earliest event time, because occupancy takes effect from event time.
	Owner string
	// ConflictGroup lists every entity claiming the key, sorted by claim
	// precedence, when more than one entity is involved.
	ConflictGroup []string
}
