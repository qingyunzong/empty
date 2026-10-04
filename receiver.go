// Package recvwin implements a bounded sequence-number receive window.
//
// Out-of-order frames are buffered inside the window; only the contiguous
// prefix is acknowledged (delivered). Frames beyond the window are rejected
// with explicit backpressure, and a frame whose sequence number was already
// seen with a different digest is reported as a conflict.
package recvwin

import "fmt"

// Result classifies the outcome of a Receive call.
type Result int

const (
	// Delivered means the frame extended the contiguous prefix and the
	// window advanced (possibly releasing further buffered frames).
	Delivered Result = iota
	// Buffered means the frame is inside the window but out of order;
	// it is stored until the gap before it is filled.
	Buffered
	// Duplicate means the frame was already accepted with the same digest.
	Duplicate
	// Stale means the sequence number is below the window base; the frame
	// was already released (or never belonged to this window).
	Stale
	// Conflict means the sequence number was already accepted with a
	// different digest. The new frame is rejected and the old one kept.
	Conflict
	// Backpressure means the sequence number is at or beyond the window
	// end; the sender must wait for the window to advance.
	Backpressure
)

func (r Result) String() string {
	switch r {
	case Delivered:
		return "Delivered"
	case Buffered:
		return "Buffered"
	case Duplicate:
		return "Duplicate"
	case Stale:
		return "Stale"
	case Conflict:
		return "Conflict"
	case Backpressure:
		return "Backpressure"
	}
	return fmt.Sprintf("Result(%d)", int(r))
}

// Receiver is a bounded sliding receive window over sequence numbers
// [Base, Base+Window). It is not safe for concurrent use.
type Receiver struct {
	base   uint64
	window int
	buf    map[uint64]string // buffered out-of-order frames: seq -> digest
}

// New creates a Receiver expecting sequence numbers from 0 with the given
// window size. It panics if window <= 0.
func New(window int) *Receiver {
	if window <= 0 {
		panic("recvwin: window must be positive")
	}
	return &Receiver{window: window, buf: make(map[uint64]string)}
}

// Base returns the next expected sequence number (the window base).
// All sequence numbers below Base have been delivered and released.
func (r *Receiver) Base() uint64 { return r.base }

// Window returns the configured window size.
func (r *Receiver) Window() int { return r.window }

// Buffered returns the number of out-of-order frames currently held.
func (r *Receiver) Buffered() int { return len(r.buf) }

// Receive accepts one frame identified by seq with content digest.
// It returns the classification and the sequence numbers released by this
// call (the newly contiguous prefix, empty unless the result is Delivered).
func (r *Receiver) Receive(seq uint64, digest string) (Result, []uint64) {
	switch {
	case seq < r.base:
		return Stale, nil
	case seq >= r.base+uint64(r.window):
		return Backpressure, nil
	}
	if prev, ok := r.buf[seq]; ok {
		if prev == digest {
			return Duplicate, nil
		}
		return Conflict, nil
	}
	r.buf[seq] = digest
	var released []uint64
	for {
		d, ok := r.buf[r.base]
		if !ok {
			break
		}
		_ = d
		delete(r.buf, r.base)
		released = append(released, r.base)
		r.base++
	}
	if len(released) > 0 {
		return Delivered, released
	}
	return Buffered, nil
}

// Gap returns the minimal missing interval [lo, hi] inside the window: the
// range of sequence numbers the sender must (re)transmit to make progress.
// lo is always the window base; hi is the sequence number just before the
// first buffered frame, or the window end if nothing is buffered.
func (r *Receiver) Gap() (lo, hi uint64) {
	lo = r.base
	hi = r.base + uint64(r.window) - 1
	for seq := range r.buf {
		if seq > lo && seq-1 < hi {
			hi = seq - 1
		}
	}
	return lo, hi
}
