package formal

import "errors"

// Sentinel errors returned by Coordinator. Callers should use errors.Is
// because most errors are wrapped with diagnostic context.
var (
	ErrNotInitialized      = errors.New("formal: coordinator is not initialized")
	ErrAlreadyInitialized  = errors.New("formal: coordinator is already initialized")
	ErrEmptyMembership     = errors.New("formal: membership must not be empty")
	ErrInvalidMember       = errors.New("formal: member id must not be blank")
	ErrDuplicateMember     = errors.New("formal: duplicate member id")
	ErrUnknownMember       = errors.New("formal: member is not part of the active generation")
	ErrStaleGeneration     = errors.New("formal: request belongs to a stale generation")
	ErrUnknownGeneration   = errors.New("formal: request belongs to an unknown future generation")
	ErrStaleStep           = errors.New("formal: request belongs to a stale step")
	ErrFutureStep          = errors.New("formal: request is ahead of the active step")
	ErrConflictingGradient = errors.New("formal: conflicting gradient already accepted for member and step")
	ErrInvalidHeartbeat    = errors.New("formal: heartbeat sequence must be positive")
	ErrStaleHeartbeat      = errors.New("formal: heartbeat sequence is not newer than the last accepted")
	ErrNoCompletedStep     = errors.New("formal: active generation has not completed a step")
	ErrCheckpointNotFound  = errors.New("formal: checkpoint not found")
	ErrCheckpointAborted   = errors.New("formal: checkpoint was aborted by a generation change")
)
