package dataeng

import "errors"

// Errors returned by the decoder. Push and Finish wrap these sentinels with
// detail where useful; use errors.Is to identify the class of failure.
var (
	// ErrInvalidConfig reports a rejected field declaration, bias, endian,
	// projection, or row budget.
	ErrInvalidConfig = errors.New("dataeng: invalid configuration")
	// ErrState reports Push or Finish after a terminal state (failure,
	// successful Finish, or repeated Finish).
	ErrState = errors.New("dataeng: decoder is in a terminal state")
	// ErrTruncated reports physical EOF without a successful terminator or
	// an incomplete group header or literal slot.
	ErrTruncated = errors.New("dataeng: truncated S8 data")
	// ErrTypeMismatch reports an opcode that cannot be used for the current
	// field kind.
	ErrTypeMismatch = errors.New("dataeng: opcode is invalid for field kind")
	// ErrBadPadding reports non-space bytes after the declared width in the
	// final slot of a bytes field.
	ErrBadPadding = errors.New("dataeng: non-space padding in bytes field")
	// ErrRowBoundary reports opcode 252 while a row is incomplete.
	ErrRowBoundary = errors.New("dataeng: terminator is not at a row boundary")
	// ErrTerminatorHeader reports a nonzero opcode after opcode 252 in the
	// terminating group.
	ErrTerminatorHeader = errors.New("dataeng: nonzero opcode after terminator")
	// ErrExtraData reports physical bytes after the terminating group.
	ErrExtraData = errors.New("dataeng: physical data after terminating group")
	// ErrRowLimit reports that another row would exceed MaxRows.
	ErrRowLimit = errors.New("dataeng: row limit exceeded")
)
