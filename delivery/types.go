package delivery

import (
	"errors"
	"time"
)

// Epoch identifies a link generation. A new epoch is allocated every time the
// link is attached, so dispositions from a retired link can be fenced off.
type Epoch uint64

// DeliveryID is the AMQP delivery-id (transfer-id) scoped to one link epoch.
type DeliveryID uint64

// Tag is an AMQP delivery-tag. The raw tag bytes are held as a string so that
// tags are comparable and usable as map keys while preserving arbitrary bytes.
type Tag string

// NewTag builds a Tag from the raw delivery-tag bytes.
func NewTag(b []byte) Tag {
	return Tag(b)
}

// Bytes returns the raw delivery-tag bytes.
func (t Tag) Bytes() []byte {
	return []byte(t)
}

// String returns the tag as a string.
func (t Tag) String() string {
	return string(t)
}

// Outcome is the AMQP delivery outcome associated with a disposition.
type Outcome string

const (
	// OutcomeNone means no outcome has been produced yet.
	OutcomeNone Outcome = ""
	// OutcomeAccepted is only valid after the payload has been committed.
	OutcomeAccepted Outcome = "accepted"
	OutcomeRejected Outcome = "rejected"
	OutcomeReleased Outcome = "released"
	OutcomeModified Outcome = "modified"
)

var (
	// ErrNotFound is returned by Store implementations when no record exists.
	ErrNotFound = errors.New("delivery: record not found")
	// ErrAlreadyExists is returned by Store.Put for a duplicate tag.
	ErrAlreadyExists = errors.New("delivery: record already exists")
	// ErrStaleGeneration means a disposition references a retired link epoch.
	ErrStaleGeneration = errors.New("delivery: disposition belongs to a retired link generation")
	// ErrUnknownDelivery means the tracker has no record for the tag.
	ErrUnknownDelivery = errors.New("delivery: unknown delivery tag")
	// ErrUnknownTransaction means the transaction id is not active.
	ErrUnknownTransaction = errors.New("delivery: unknown transaction")
	// ErrAlreadySettled means a terminal disposition was already applied.
	ErrAlreadySettled = errors.New("delivery: delivery already settled")
	// ErrInvalidState means the requested transition is not allowed.
	ErrInvalidState = errors.New("delivery: invalid state transition")
	// ErrNoActiveGeneration means Incoming was called before BeginGeneration.
	ErrNoActiveGeneration = errors.New("delivery: no active link generation")
)

// Record is the durable state of one delivery, keyed by Tag.
type Record struct {
	// Tag is the AMQP delivery-tag, stable across link resumptions.
	Tag Tag
	// LinkEpoch is the generation on which the delivery is currently active.
	LinkEpoch Epoch
	// DeliveryID is the delivery-id on the current generation.
	DeliveryID DeliveryID
	// Settled is true once a settled (terminal) disposition has been applied.
	Settled bool
	// Outcome is the current outcome; OutcomeNone until one is produced.
	Outcome Outcome
	// TxnID is the enlisting transaction, empty when not transactional.
	TxnID string
	// Committed is true once the payload has been durably committed.
	Committed bool
	// UpdatedAt is the time of the last state change.
	UpdatedAt time.Time
}
