package store

import "errors"

// ErrCrash is returned by operations interrupted by an injected power loss.
var ErrCrash = errors.New("store: simulated power loss")

// FaultPoint identifies a crash-injection boundary inside Compact.
type FaultPoint int

const (
	FaultNone FaultPoint = iota
	// FaultBeforeCopy fires before any live page is copied.
	FaultBeforeCopy
	// FaultAfterCopy fires after the new compact segment is fully written
	// and fsynced, before the new index is flushed.
	FaultAfterCopy
	// FaultAfterIndexFlush fires after the new generation's index log is
	// written, fsynced and renamed into place, before the commit record.
	FaultAfterIndexFlush
	// FaultAfterCommit fires after the COMMIT record atomically publishes
	// the new generation, before old segments are retired.
	FaultAfterCommit
	// FaultDuringRetire fires after the first obsolete segment is deleted
	// but before retirement completes.
	FaultDuringRetire
)

// FaultInjector injects a single simulated power loss at a chosen boundary.
// A nil *FaultInjector or FaultNone disables injection.
type FaultInjector struct {
	Point FaultPoint
}

func (f *FaultInjector) hook(p FaultPoint) error {
	if f != nil && f.Point == p {
		return ErrCrash
	}
	return nil
}
