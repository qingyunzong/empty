package dataeng

// ID identifies a resource in the upstream API.
type ID string

// EventKind describes a state transition produced by a Detector.
type EventKind uint8

const (
	// EventCreated means the ID was not known before the current generation.
	EventCreated EventKind = iota + 1

	// EventDeleted is the soft-deletion notification. It is emitted at most
	// once for a version of the resource.
	EventDeleted

	// EventRestored means a previously deleted ID appeared in the current
	// listing again.
	EventRestored
)

// String returns a stable, human-readable event name.
func (k EventKind) String() string {
	switch k {
	case EventCreated:
		return "created"
	case EventDeleted:
		return "deleted"
	case EventRestored:
		return "restored"
	default:
		return "unknown"
	}
}

// Status is the detector's view of a resource.
type Status uint8

const (
	// StatusActive means the resource has been seen and is not a deletion
	// candidate.
	StatusActive Status = iota

	// StatusPending means the resource is missing, but has not reached the
	// deletion threshold yet.
	StatusPending

	// StatusDeleted means a delete event has been emitted for the resource.
	StatusDeleted
)

// String returns a stable, human-readable status name.
func (s Status) String() string {
	switch s {
	case StatusActive:
		return "active"
	case StatusPending:
		return "pending"
	case StatusDeleted:
		return "deleted"
	default:
		return "unknown"
	}
}

// Event is a state transition the collector must apply downstream.
//
// Version is monotonic per ID. A new resource starts at version 1; every
// subsequent delete or restore increments it. Generation is the complete
// generation in which the transition was observed.
type Event struct {
	Kind       EventKind
	ID         ID
	Version    uint64
	Generation uint64
	Missing    int
}

// Config controls deletion and recheck behaviour.
//
// A zero value is valid and uses DefaultDeleteAfter and
// DefaultMaxRecheckCycles.
type Config struct {
	// DeleteAfter is the number of consecutive scheduled complete-generation
	// rechecks in which an ID may be absent before EventDeleted is emitted.
	// Values less than zero are rejected; zero selects the default.
	DeleteAfter int

	// MaxRecheckCycles is the upper bound, measured in complete generations,
	// between two scheduled rechecks of the same ID. It is also the number of
	// rotation slots. Values less than zero are rejected; zero selects the
	// default.
	MaxRecheckCycles int

	// HashSalt is mixed into the consistent-hash key. It must remain stable
	// across restarts so that an ID keeps its slot. An empty salt is valid.
	HashSalt string
}

const (
	// DefaultDeleteAfter is used when Config.DeleteAfter is zero.
	DefaultDeleteAfter = 3

	// DefaultMaxRecheckCycles is used when Config.MaxRecheckCycles is zero.
	DefaultMaxRecheckCycles = 8
)

// Listing is one response from the resource API.
type Listing struct {
	// Complete must be true only when IDs is the entire current list from a
	// successful response. Do not set it for an error page, a rate-limit
	// response, a truncated page, or a parse failure.
	Complete bool

	// IDs may contain duplicates; duplicates are observed once.
	IDs []ID
}

// RecordInfo is a read-only copy of a tracked resource's state.
type RecordInfo struct {
	ID                    ID
	Version               uint64
	Status                Status
	Missing               int
	Slot                  int
	FirstGeneration       uint64
	LastPresentGeneration uint64
}

// Stats is a point-in-time summary of a Detector.
type Stats struct {
	Generation             uint64
	IncompleteObservations uint64
	Records                int
	Active                 int
	Pending                int
	Deleted                int
}
