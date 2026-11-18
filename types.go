package formal

import (
	"errors"
	"fmt"
)

// ObjectID identifies an object managed by the deletion controller.
type ObjectID string

// KeyID identifies a terminal key (finalizer) on an object.
type KeyID string

// ResourceID identifies an external resource whose cleanup must be confirmed.
//
// Resource identifiers are unique within an object. If the same resource is
// referenced by several keys, it is cleaned up once and the completion is
// shared by all of them.
type ResourceID string

// Result is the terminal outcome reported by an external cleanup operation.
//
// An external attempt produces exactly one terminal result. A cancelled result
// means the attempt stopped without performing the cleanup, so the resource may
// be retried safely.
type Result uint8

const (
	ResultSucceeded Result = iota + 1
	ResultFailed
	ResultCancelled
)

func (r Result) String() string {
	switch r {
	case ResultSucceeded:
		return "succeeded"
	case ResultFailed:
		return "failed"
	case ResultCancelled:
		return "cancelled"
	default:
		return fmt.Sprintf("Result(%d)", uint8(r))
	}
}

// ResourceState is the ledger's view of one external resource.
type ResourceState uint8

const (
	ResourcePending ResourceState = iota
	ResourceInFlight
	ResourceSucceeded
	ResourceFailed
)

func (s ResourceState) String() string {
	switch s {
	case ResourcePending:
		return "pending"
	case ResourceInFlight:
		return "in-flight"
	case ResourceSucceeded:
		return "succeeded"
	case ResourceFailed:
		return "failed"
	default:
		return fmt.Sprintf("ResourceState(%d)", uint8(s))
	}
}

// KeySpec declares a terminal key and the ordered external resources that must
// be confirmed before the key can be removed.
type KeySpec struct {
	Key       KeyID        `json:"key"`
	Resources []ResourceID `json:"resources,omitempty"`
}

// EventKind identifies an externally supplied ledger event.
type EventKind uint8

const (
	EventRegister EventKind = iota + 1
	EventBeginCleanup
	EventDelete
	EventReconcile
	EventConfirm
	EventRetry
	EventCancel
)

func (k EventKind) String() string {
	switch k {
	case EventRegister:
		return "register"
	case EventBeginCleanup:
		return "begin-cleanup"
	case EventDelete:
		return "delete"
	case EventReconcile:
		return "reconcile"
	case EventConfirm:
		return "confirm"
	case EventRetry:
		return "retry"
	case EventCancel:
		return "cancel"
	default:
		return fmt.Sprintf("EventKind(%d)", uint8(k))
	}
}

// Event is one durable input to the ledger.
//
// Confirm events carry the attempt returned by the corresponding
// EffectStartCleanup. A success is recorded even if its attempt is stale,
// because the external side effect has happened. Failed and cancelled results
// are only applied to the current matching attempt.
type Event struct {
	Kind     EventKind  `json:"kind"`
	Object   ObjectID   `json:"object"`
	Keys     []KeySpec  `json:"keys,omitempty"`
	Resource ResourceID `json:"resource,omitempty"`
	Attempt  uint64     `json:"attempt,omitempty"`
	Result   Result     `json:"result,omitempty"`
}

// EffectKind identifies work the ledger asks the controller to perform.
type EffectKind uint8

const (
	EffectStartCleanup EffectKind = iota + 1
	EffectRemoveKey
	EffectFinishObject
)

func (k EffectKind) String() string {
	switch k {
	case EffectStartCleanup:
		return "start-cleanup"
	case EffectRemoveKey:
		return "remove-key"
	case EffectFinishObject:
		return "finish-object"
	default:
		return fmt.Sprintf("EffectKind(%d)", uint8(k))
	}
}

// Effect is a side effect emitted by Reconcile. StartCleanup is emitted at most
// once per attempt; RemoveKey is emitted only after every resource of the key
// has exactly one successful confirmation.
type Effect struct {
	Kind     EffectKind `json:"kind"`
	Object   ObjectID   `json:"object"`
	Key      KeyID      `json:"key,omitempty"`
	Resource ResourceID `json:"resource,omitempty"`
	Attempt  uint64     `json:"attempt,omitempty"`
}

// KeySnapshot is the immutable view of one terminal key.
type KeySnapshot struct {
	Key       KeyID        `json:"key"`
	Resources []ResourceID `json:"resources,omitempty"`
	Removed   bool         `json:"removed"`
	Removals  uint64       `json:"removals"`
}

// ResourceSnapshot is the immutable view of one external resource.
type ResourceSnapshot struct {
	Resource ResourceID    `json:"resource"`
	State    ResourceState `json:"state"`
	Attempt  uint64        `json:"attempt"`
}

// Snapshot is a point-in-time, deep copy of an object's ledger state.
type Snapshot struct {
	Object         ObjectID              `json:"object"`
	Cleaning       bool                  `json:"cleaning"`
	Deleting       bool                  `json:"deleting"`
	Finished       bool                  `json:"finished"`
	Keys           []KeySnapshot         `json:"keys"`
	Resources      []ResourceSnapshot    `json:"resources"`
	SuccessRecords map[ResourceID]uint64 `json:"successRecords"`
}

// These errors identify protocol misuse. A repeated (idempotent) operation is
// not an error; it is reported with applied == false by the convenience
// methods that return a bool.
var (
	ErrInvalidEvent    = errors.New("formal: invalid event")
	ErrUnknownObject   = errors.New("formal: unknown object")
	ErrUnknownResource = errors.New("formal: unknown resource")
	ErrAttemptInFlight = errors.New("formal: attempt is already in flight")
)
