package formal

import (
	"errors"
	"fmt"
)

var (
	// ErrInvalidConfig reports a malformed quota topology.
	ErrInvalidConfig = errors.New("quota: invalid configuration")
	// ErrInvalidAmount reports a negative or overflowing quantity.
	ErrInvalidAmount = errors.New("quota: invalid amount")
	// ErrUnknownNode reports a node not present in the quota tree.
	ErrUnknownNode = errors.New("quota: unknown node")
	// ErrUnknownHold reports a reservation or allocation identifier that is not
	// currently tracked.
	ErrUnknownHold = errors.New("quota: unknown hold")
	// ErrDuplicateID reports reuse of an active hold identifier.
	ErrDuplicateID = errors.New("quota: duplicate hold id")
	// ErrInsufficientQuota reports an all-or-nothing reservation that cannot be
	// satisfied by the currently available capacity.
	ErrInsufficientQuota = errors.New("quota: insufficient quota")
	// ErrReclaimShortfall reports that preemption reclaimed less than requested.
	ErrReclaimShortfall = errors.New("quota: reclaim shortfall")
)

// ShortfallError describes a partial preemption. The reclaimed quantities were
// applied to the calculator; Missing is the part that could not be reclaimed.
type ShortfallError struct {
	Missing Resources
}

func (e *ShortfallError) Error() string {
	return fmt.Sprintf("%v: missing %v", ErrReclaimShortfall, e.Missing)
}

// Is allows errors.Is(err, ErrReclaimShortfall).
func (e *ShortfallError) Is(target error) bool {
	return target == ErrReclaimShortfall
}
