package dataeng

import "errors"

var (
	// ErrInvalidMessageID reports a message coordinate that cannot exist in
	// Pulsar. Ledger and entry IDs must be non-negative and a batch index must
	// be either -1 (a non-batched message) or non-negative.
	ErrInvalidMessageID = errors.New("dataeng: invalid message id")

	// ErrStaleGeneration reports an acknowledgement or state operation that
	// was produced for an older topic or subscription generation.
	ErrStaleGeneration = errors.New("dataeng: stale topic or subscription generation")

	// ErrScopeMismatch reports an attempt to restore state into a tracker that
	// belongs to a different topic or subscription.
	ErrScopeMismatch = errors.New("dataeng: state belongs to a different scope")

	// ErrInvalidState reports malformed or unsupported serialized state.
	ErrInvalidState = errors.New("dataeng: invalid acknowledgement state")

	// ErrInvalidAckType reports an unknown acknowledgement mode.
	ErrInvalidAckType = errors.New("dataeng: invalid acknowledgement type")
)
