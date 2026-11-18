package formal

import (
	"errors"
	"fmt"
)

// InstanceID identifies one discovered instance.
type InstanceID string

// Health is the latest health observation for an instance.
type Health uint8

const (
	HealthUnknown Health = iota
	HealthHealthy
	HealthUnhealthy
)

func (h Health) String() string {
	switch h {
	case HealthUnknown:
		return "unknown"
	case HealthHealthy:
		return "healthy"
	case HealthUnhealthy:
		return "unhealthy"
	default:
		return fmt.Sprintf("Health(%d)", uint8(h))
	}
}

// DrainState describes the connection-pool drain state of an instance.
type DrainState uint8

const (
	// DrainActive means the pool accepts new requests.
	DrainActive DrainState = iota
	// DrainDraining means the pool is draining. No new request may be
	// allocated to the instance while it is in this state.
	DrainDraining
	// DrainDrained means the pool has finished draining. The instance leaves
	// the live set until a newer drain observation or generation revives it.
	DrainDrained
)

func (d DrainState) String() string {
	switch d {
	case DrainActive:
		return "active"
	case DrainDraining:
		return "draining"
	case DrainDrained:
		return "drained"
	default:
		return fmt.Sprintf("DrainState(%d)", uint8(d))
	}
}

// EventKind selects which aspect of an instance an Event updates.
type EventKind uint8

const (
	// EventHealth updates the health aspect.
	EventHealth EventKind = iota
	// EventWeight updates the weight aspect.
	EventWeight
	// EventDrain updates the drain aspect.
	EventDrain
	// EventAdd publishes that the instance is present.
	EventAdd
	// EventRemove publishes that the instance is absent.
	EventRemove
)

func (k EventKind) String() string {
	switch k {
	case EventHealth:
		return "health"
	case EventWeight:
		return "weight"
	case EventDrain:
		return "drain"
	case EventAdd:
		return "add"
	case EventRemove:
		return "remove"
	default:
		return fmt.Sprintf("EventKind(%d)", uint8(k))
	}
}

// Event is one discovery observation.
//
// ID, Generation, Revision, and Kind are always significant. The remaining
// fields are interpreted according to Kind.
type Event struct {
	ID         InstanceID
	Generation uint64
	Revision   uint64
	Kind       EventKind

	Health Health
	Weight uint32
	Drain  DrainState
}

// HealthEvent creates a health observation.
func HealthEvent(id InstanceID, generation, revision uint64, health Health) Event {
	return Event{
		ID:         id,
		Generation: generation,
		Revision:   revision,
		Kind:       EventHealth,
		Health:     health,
	}
}

// WeightEvent creates a weight observation.
func WeightEvent(id InstanceID, generation, revision uint64, weight uint32) Event {
	return Event{
		ID:         id,
		Generation: generation,
		Revision:   revision,
		Kind:       EventWeight,
		Weight:     weight,
	}
}

// DrainEvent creates a connection-pool drain observation.
func DrainEvent(id InstanceID, generation, revision uint64, state DrainState) Event {
	return Event{
		ID:         id,
		Generation: generation,
		Revision:   revision,
		Kind:       EventDrain,
		Drain:      state,
	}
}

// AddEvent creates a membership observation that marks the instance present.
func AddEvent(id InstanceID, generation, revision uint64) Event {
	return Event{
		ID:         id,
		Generation: generation,
		Revision:   revision,
		Kind:       EventAdd,
	}
}

// RemoveEvent creates a membership observation that marks the instance absent.
func RemoveEvent(id InstanceID, generation, revision uint64) Event {
	return Event{
		ID:         id,
		Generation: generation,
		Revision:   revision,
		Kind:       EventRemove,
	}
}

var (
	// ErrEmptyInstanceID is returned for an event without an instance ID.
	ErrEmptyInstanceID = errors.New("discovery: empty instance ID")
	// ErrInvalidKind is returned for an unknown event kind.
	ErrInvalidKind = errors.New("discovery: invalid event kind")
	// ErrInvalidHealth is returned for an unknown health value.
	ErrInvalidHealth = errors.New("discovery: invalid health state")
	// ErrInvalidDrain is returned for an unknown drain state.
	ErrInvalidDrain = errors.New("discovery: invalid drain state")
)

// Validate reports whether the event is structurally valid.
func (e Event) Validate() error {
	if e.ID == "" {
		return ErrEmptyInstanceID
	}

	switch e.Kind {
	case EventHealth:
		if e.Health > HealthUnhealthy {
			return fmt.Errorf("%w: %d", ErrInvalidHealth, uint8(e.Health))
		}
	case EventWeight:
		// Every uint32 is a valid weight.
	case EventDrain:
		if e.Drain > DrainDrained {
			return fmt.Errorf("%w: %d", ErrInvalidDrain, uint8(e.Drain))
		}
	case EventAdd, EventRemove:
		// Membership events have no extra payload.
	default:
		return fmt.Errorf("%w: %d", ErrInvalidKind, uint8(e.Kind))
	}

	return nil
}
