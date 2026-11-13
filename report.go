package dataeng

import "bytes"

// Report is a batch of keys produced for one worker interval.
//
// Exhausted means that the worker's source has no more keys in the interval.
type Report struct {
	Keys      []Key
	Exhausted bool
}

// Status is the completion state of a worker interval.
type Status uint8

const (
	// StatusIncomplete means the interval still has keys to process.
	StatusIncomplete Status = iota

	// StatusComplete means the interval was completed successfully.
	StatusComplete

	// StatusFailed means the interval cannot be completed.
	StatusFailed
)

// State is an alias for Status.
type State = Status

const (
	Incomplete = StatusIncomplete
	Complete   = StatusComplete
	Failed     = StatusFailed
)

// String returns a readable status name.
func (s Status) String() string {
	switch s {
	case StatusIncomplete:
		return "incomplete"
	case StatusComplete:
		return "complete"
	case StatusFailed:
		return "failed"
	default:
		return "unknown"
	}
}

// ValidateReport validates one report against an interval, without considering
// ownership by other intervals.
//
// It returns StatusComplete for a report whose last key equals the interval
// end, or for an exhausted report whose last key is below the interval end.
// An exhausted empty report also completes the interval: the scan reached the
// end of the source without producing a key. An exhausted report ending exactly
// at the interval end is a failure.
func ValidateReport(interval Interval, keys []Key, exhausted bool) (Status, error) {
	if err := interval.Validate(); err != nil {
		return StatusFailed, err
	}

	for _, key := range keys {
		if !interval.Contains(key) {
			return StatusIncomplete, ErrKeyOutsideInterval
		}
	}

	if len(keys) == 0 {
		if exhausted {
			return StatusComplete, nil
		}
		return StatusIncomplete, nil
	}

	last := keys[len(keys)-1]
	atEnd := bytes.Equal(last, interval.End)
	if exhausted {
		if atEnd {
			return StatusFailed, ErrExhaustedAtEnd
		}
		return StatusComplete, nil
	}
	if atEnd {
		return StatusComplete, nil
	}
	return StatusIncomplete, nil
}
