package forward

// State is the unique terminal state of a Forward call. Exactly one state
// is ever recorded; a later cancel or response never overwrites it.
type State int

const (
	StatePending State = iota
	StateDelivered
	StateCanceled
	StateReadFailed
	StateWriteFailed
	StateLimitExceeded
)

func (s State) String() string {
	switch s {
	case StatePending:
		return "pending"
	case StateDelivered:
		return "delivered"
	case StateCanceled:
		return "canceled"
	case StateReadFailed:
		return "read-failed"
	case StateWriteFailed:
		return "write-failed"
	case StateLimitExceeded:
		return "limit-exceeded"
	}
	return "unknown"
}
