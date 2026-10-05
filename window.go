// Package recvwin implements a bounded receive window over sequence numbers.
//
// Frames may arrive out of order; they are buffered until they form a
// contiguous prefix, which is the only part ever acknowledged. Frames beyond
// the window are rejected with explicit backpressure, and a sequence number
// re-delivered with a different digest is reported as a conflict.
package recvwin

import (
	"errors"
	"fmt"
)

var (
	// ErrBackpressure is returned when a frame's sequence number lies at or
	// beyond the upper edge of the receive window. The frame is not stored;
	// the sender should retry after the window advances.
	ErrBackpressure = errors.New("recvwin: sequence beyond window")

	// ErrConflict is returned when a buffered sequence number is delivered
	// again with a different digest. The buffered frame is left untouched.
	ErrConflict = errors.New("recvwin: digest conflict for sequence")
)

// Outcome classifies the result of an accepted Insert call.
type Outcome int

const (
	// Stored means the frame was newly buffered (and may have advanced the
	// acknowledgement frontier).
	Stored Outcome = iota
	// Duplicate means the frame was already acknowledged (sequence below
	// the frontier) or is already buffered with the same digest.
	Duplicate
)

func (o Outcome) String() string {
	if o == Stored {
		return "stored"
	}
	return "duplicate"
}

// Result reports the effect of an Insert.
type Result struct {
	Outcome Outcome
	// Ack is the acknowledgement frontier after the call: every sequence
	// number below Ack forms a contiguous received prefix.
	Ack uint64
	// Released is the number of buffered frames freed from the window by
	// this insert (including the inserted frame itself if it completed the
	// prefix).
	Released int
}

// Window is a bounded receive window over sequence numbers
// [frontier, frontier+size). It is not safe for concurrent use.
type Window struct {
	frontier uint64
	size     uint64
	buf      map[uint64][32]byte
}

// New returns a Window expecting its first frame at sequence number start,
// with room for size in-flight sequence numbers. It panics if size is zero.
func New(start, size uint64) *Window {
	if size == 0 {
		panic("recvwin: window size must be positive")
	}
	return &Window{frontier: start, size: size, buf: make(map[uint64][32]byte)}
}

// Insert delivers a frame with the given sequence number and content digest.
//
// Frames below the frontier or already buffered with the same digest are
// harmless duplicates. Frames at or beyond frontier+size fail with
// ErrBackpressure. A buffered sequence number re-delivered with a different
// digest fails with ErrConflict and leaves the window unchanged.
func (w *Window) Insert(seq uint64, digest [32]byte) (Result, error) {
	switch {
	case seq < w.frontier:
		return Result{Outcome: Duplicate, Ack: w.frontier}, nil
	case seq-w.frontier >= w.size:
		return Result{Ack: w.frontier}, fmt.Errorf("%w: seq=%d window=[%d,%d)",
			ErrBackpressure, seq, w.frontier, w.frontier+w.size)
	}
	if prev, ok := w.buf[seq]; ok {
		if prev != digest {
			return Result{Ack: w.frontier}, fmt.Errorf("%w: seq=%d", ErrConflict, seq)
		}
		return Result{Outcome: Duplicate, Ack: w.frontier}, nil
	}

	w.buf[seq] = digest
	released := 0
	for {
		if _, ok := w.buf[w.frontier]; !ok {
			break
		}
		delete(w.buf, w.frontier)
		w.frontier++
		released++
	}
	return Result{Outcome: Stored, Ack: w.frontier, Released: released}, nil
}

// Ack returns the acknowledgement frontier: the lowest sequence number not
// yet received. Everything below it is a contiguous confirmed prefix.
func (w *Window) Ack() uint64 { return w.frontier }

// Buffered returns the number of out-of-order frames currently held.
func (w *Window) Buffered() int { return len(w.buf) }

// Gap returns the minimal missing interval [lo, hi) at the head of the
// window: lo is the acknowledgement frontier and hi is the lowest buffered
// sequence number, or the upper window edge if nothing is buffered.
func (w *Window) Gap() (lo, hi uint64) {
	lo = w.frontier
	hi = w.frontier + w.size
	for seq := range w.buf {
		if seq < hi {
			hi = seq
		}
	}
	return lo, hi
}
