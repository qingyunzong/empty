package forward

import "errors"

// ErrLimitExceeded is the terminal error when the request body grows past
// the configured byte budget. It is a budget decision made by the
// forwarder itself, never a wrapped upstream failure.
var ErrLimitExceeded = errors.New("forward: body exceeds configured limit")

// ReadError wraps a failure to read the next chunk from upstream, keeping
// it distinguishable from ErrLimitExceeded via errors.As.
type ReadError struct{ Err error }

func (e *ReadError) Error() string { return "forward: read upstream: " + e.Err.Error() }
func (e *ReadError) Unwrap() error { return e.Err }
