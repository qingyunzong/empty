package dataeng

import (
	"fmt"
	"time"
)

const snapshotVersion = 1

// State is a JSON-serializable snapshot of an Aggregator. It contains the
// unfinished event, including its original start and end offsets, plus the
// sequence number needed to continue emitting unique events.
type State struct {
	Version int           `json:"version"`
	NextSeq uint64        `json:"next_seq"`
	Pending *PendingEvent `json:"pending,omitempty"`
}

// Snapshot copies the current aggregator state. The returned value owns its
// slices and can be marshaled or stored without coordinating with the
// aggregator.
func (a *Aggregator) Snapshot() State {
	a.mu.Lock()
	defer a.mu.Unlock()

	state := State{
		Version: snapshotVersion,
		NextSeq: a.nextSeq,
	}
	if a.current != nil {
		pending := *a.current
		pending.Lines = append([]string(nil), a.current.Lines...)
		state.Pending = &pending
	}
	return state
}

// Restore replaces the aggregator state with a snapshot. The Aggregator must
// already be configured with the same Rule and options that produced the
// snapshot; those values are intentionally not serialized.
func (a *Aggregator) Restore(state State) error {
	if state.Version != snapshotVersion {
		return fmt.Errorf("%w: got %d, want %d", ErrSnapshotVersion, state.Version, snapshotVersion)
	}

	pending, err := clonePending(state.Pending, a.now())
	if err != nil {
		return err
	}
	nextSeq := state.NextSeq
	if nextSeq == 0 {
		nextSeq = 1
	}
	if pending != nil && nextSeq <= pending.Seq {
		nextSeq = pending.Seq + 1
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	a.current = pending
	a.nextSeq = nextSeq
	return nil
}

func clonePending(source *PendingEvent, fallback time.Time) (*PendingEvent, error) {
	if source == nil {
		return nil, nil
	}
	if len(source.Lines) == 0 {
		return nil, fmt.Errorf("%w: pending event has no lines", ErrSnapshotCorrupt)
	}
	if source.EndOffset < source.StartOffset {
		return nil, fmt.Errorf("%w: pending event end offset precedes start offset", ErrSnapshotCorrupt)
	}

	pending := *source
	pending.Lines = append([]string(nil), source.Lines...)
	pending.Size = linesSize(pending.Lines)
	if pending.Updated.IsZero() {
		pending.Updated = pending.Started
	}
	if pending.Started.IsZero() {
		pending.Started = pending.Updated
	}
	if pending.Started.IsZero() {
		pending.Started = fallback
		pending.Updated = pending.Started
	}
	return &pending, nil
}
