package dataeng

import (
	"errors"
	"fmt"
)

// ErrChannelOutOfRange is returned when an event references a channel
// index outside [0, numChannels).
var ErrChannelOutOfRange = errors.New("dataeng: channel index out of range")

// Result is the outcome of feeding one input event to a BarrierAligner.
type Result struct {
	// Emit holds records that must be emitted downstream now, in the
	// exact order they must appear in the output stream.
	Emit []Record
	// Snapshot is non-nil when the event completed a checkpoint. Any
	// given checkpoint ID completes at most once.
	Snapshot *Snapshot
}

// Snapshot describes a completed checkpoint.
type Snapshot struct {
	CheckpointID int64
	// Inflight holds the records captured by an unaligned checkpoint in
	// their original arrival order. Replaying them in this order on
	// recovery reproduces the fault-free output. It is nil for aligned
	// checkpoints.
	Inflight []Record
}

// BarrierAligner coordinates checkpoint barriers across the input
// channels of one multi-input operator.
//
// For aligned checkpoints it blocks each channel as its barrier
// arrives and buffers post-barrier records; once every channel has
// reported, the checkpoint completes and the buffered records are
// released in their original arrival order. For unaligned checkpoints
// records keep flowing and are additionally captured as in-flight data
// that becomes part of the checkpoint.
//
// A checkpoint completes at most once: barriers of an already
// completed checkpoint are ignored, and a cancellation marker arriving
// after completion cannot revoke the committed snapshot. A
// cancellation marker for a pending checkpoint aborts it and releases
// any records held back by alignment.
//
// BarrierAligner is not safe for concurrent use; stream runtimes drive
// it from the operator's single task thread.
type BarrierAligner struct {
	numChannels int

	aligning    bool
	unaligned   bool
	currentID   int64
	received    []bool
	numReceived int

	buffered []Record // aligned: post-barrier records held on blocked channels
	inflight []Record // unaligned: copies of records overtaken by the barrier

	completed map[int64]struct{}
}

// NewBarrierAligner returns a BarrierAligner for an operator with
// numChannels input channels.
func NewBarrierAligner(numChannels int) (*BarrierAligner, error) {
	if numChannels < 1 {
		return nil, fmt.Errorf("dataeng: need at least one input channel, got %d", numChannels)
	}
	return &BarrierAligner{
		numChannels: numChannels,
		received:    make([]bool, numChannels),
		completed:   make(map[int64]struct{}),
	}, nil
}

// ProcessRecord feeds one record arriving on the given channel into
// the aligner. The returned Result lists the records (usually zero or
// one) that may be emitted downstream immediately.
func (a *BarrierAligner) ProcessRecord(channel int, r Record) (Result, error) {
	if channel < 0 || channel >= a.numChannels {
		return Result{}, ErrChannelOutOfRange
	}
	if !a.aligning {
		return Result{Emit: []Record{r}}, nil
	}
	if a.unaligned {
		// The barrier overtakes in-flight data: the record flows
		// through untouched and a copy joins the checkpoint.
		a.inflight = append(a.inflight, r)
		return Result{Emit: []Record{r}}, nil
	}
	if a.received[channel] {
		// The channel is blocked on its barrier; hold the record
		// back until the checkpoint completes or is aborted.
		a.buffered = append(a.buffered, r)
		return Result{}, nil
	}
	return Result{Emit: []Record{r}}, nil
}

// ProcessBarrier feeds one barrier (or cancellation marker) arriving
// on the given channel into the aligner.
func (a *BarrierAligner) ProcessBarrier(channel int, b Barrier) (Result, error) {
	if channel < 0 || channel >= a.numChannels {
		return Result{}, ErrChannelOutOfRange
	}
	if b.Cancellation {
		return a.processCancellation(b), nil
	}
	if _, done := a.completed[b.CheckpointID]; done {
		// This checkpoint already committed its snapshot; duplicate
		// barriers must not complete it a second time.
		return Result{}, nil
	}
	if !a.aligning {
		a.startCheckpoint(channel, b)
		return a.completeIfReady()
	}
	switch {
	case b.CheckpointID < a.currentID:
		// Late barrier of a superseded checkpoint.
		return Result{}, nil
	case b.CheckpointID > a.currentID:
		// A newer checkpoint supersedes the pending one: abort it,
		// releasing held-back records to preserve stream order, then
		// start the new checkpoint.
		res := a.abort()
		next, err := a.ProcessBarrier(channel, b)
		if err != nil {
			return res, err
		}
		res.Emit = append(res.Emit, next.Emit...)
		res.Snapshot = next.Snapshot
		return res, nil
	}
	if a.received[channel] {
		return Result{}, fmt.Errorf("dataeng: duplicate barrier for checkpoint %d on channel %d", b.CheckpointID, channel)
	}
	if a.unaligned != b.Unaligned {
		return Result{}, fmt.Errorf("dataeng: mixed aligned and unaligned barriers for checkpoint %d", b.CheckpointID)
	}
	a.received[channel] = true
	a.numReceived++
	return a.completeIfReady()
}

// IsCompleted reports whether the given checkpoint has already
// completed (and therefore committed its snapshot).
func (a *BarrierAligner) IsCompleted(checkpointID int64) bool {
	_, ok := a.completed[checkpointID]
	return ok
}

// Pending returns the ID of the checkpoint currently being aligned, if
// any.
func (a *BarrierAligner) Pending() (checkpointID int64, pending bool) {
	return a.currentID, a.aligning
}

func (a *BarrierAligner) startCheckpoint(channel int, b Barrier) {
	a.aligning = true
	a.unaligned = b.Unaligned
	a.currentID = b.CheckpointID
	a.received[channel] = true
	a.numReceived = 1
}

func (a *BarrierAligner) completeIfReady() (Result, error) {
	if a.numReceived < a.numChannels {
		return Result{}, nil
	}
	return a.complete(), nil
}

func (a *BarrierAligner) complete() Result {
	id := a.currentID
	a.completed[id] = struct{}{}
	snap := &Snapshot{CheckpointID: id}
	res := Result{Snapshot: snap}
	if a.unaligned {
		snap.Inflight = a.inflight
	} else {
		// Release held-back records in their original arrival order
		// so the output matches a fault-free pass-through.
		res.Emit = a.buffered
	}
	a.reset()
	return res
}

func (a *BarrierAligner) processCancellation(b Barrier) Result {
	if _, done := a.completed[b.CheckpointID]; done {
		// The snapshot is already committed; a late cancellation
		// cannot revoke it.
		return Result{}
	}
	if a.aligning && a.currentID == b.CheckpointID {
		return a.abort()
	}
	return Result{}
}

// abort drops the pending checkpoint. Records held back by alignment
// are released in arrival order; unaligned in-flight copies are
// discarded because the originals already flowed downstream.
func (a *BarrierAligner) abort() Result {
	res := Result{}
	if !a.unaligned {
		res.Emit = a.buffered
	}
	a.reset()
	return res
}

func (a *BarrierAligner) reset() {
	a.aligning = false
	a.unaligned = false
	a.currentID = 0
	for i := range a.received {
		a.received[i] = false
	}
	a.numReceived = 0
	a.buffered = nil
	a.inflight = nil
}
