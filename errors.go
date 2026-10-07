package forward

import "errors"

// ErrLimitExceeded reports that the request body grew past the configured
// byte limit. It is distinct from upstream read failures: use errors.Is to
// detect it.
var ErrLimitExceeded = errors.New("forward: request body exceeds byte limit")

// Outcome is the unique terminal state of a Forward call.
type Outcome int

const (
	// Delivered means the whole body was forwarded and every sink closed
	// successfully. A partially sent prefix must never report this.
	Delivered Outcome = iota
	// ReadFailed means the upstream source returned a non-EOF error.
	ReadFailed
	// LimitExceeded means the body grew past MaxBytes.
	LimitExceeded
	// Canceled means the caller's context was canceled before completion.
	Canceled
	// WriteFailed means a destination rejected a block.
	WriteFailed
)

func (o Outcome) String() string {
	switch o {
	case Delivered:
		return "delivered"
	case ReadFailed:
		return "read-failed"
	case LimitExceeded:
		return "limit-exceeded"
	case Canceled:
		return "canceled"
	case WriteFailed:
		return "write-failed"
	}
	return "unknown"
}

// SinkFailure reports that the sink at index Sink rejected a block. The
// block offset at the time of failure is recorded for byte accounting.
type SinkFailure struct {
	Sink int
	// Off is the number of body bytes fully published before the failure.
	Off int64
	Err error
}

func (e *SinkFailure) Error() string {
	return "forward: sink " + itoa(int64(e.Sink)) + " write failed at byte " + itoa(e.Off) + ": " + e.Err.Error()
}

func (e *SinkFailure) Unwrap() error { return e.Err }

// ReadFailure wraps an upstream read error so callers can tell it apart
// from a length-limit violation via errors.As / errors.Is.
type ReadFailure struct {
	// Off is the byte offset in the body at which the read failed.
	Off int64
	Err error
}

func (e *ReadFailure) Error() string {
	return "forward: upstream read failed at byte " + itoa(e.Off) + ": " + e.Err.Error()
}

func (e *ReadFailure) Unwrap() error { return e.Err }

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
