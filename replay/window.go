// Package replay implements a sliding-window anti-replay filter.
//
// Each client is tracked by a monotonically increasing counter and a
// bitmap of width W. Counters that arrive out of order but still fall
// inside the window are accepted exactly once; duplicates and counters
// older than the window are rejected. A jump forward clears the bits
// that have fallen out of the window. Counters are arbitrary-precision
// integers, so sequences beyond 2^64 are handled natively.
package replay

import (
	"errors"
	"fmt"
	"math/big"
	"sync"
)

// ErrBadSignature is returned when the request signature fails
// verification. The replay window is left untouched in that case.
var ErrBadSignature = errors.New("replay: signature verification failed")

// Window is the anti-replay state for a single client. The zero value
// is not usable; construct it with NewWindow.
type Window struct {
	width   uint64
	highest *big.Int // highest counter accepted so far; nil before the first accept
	bitmap  *big.Int // bit i (0 <= i < width) tracks counter highest-i
}

// NewWindow returns a Window that remembers the last width counters.
func NewWindow(width uint64) *Window {
	if width == 0 {
		panic("replay: window width must be positive")
	}
	return &Window{width: width, bitmap: new(big.Int)}
}

// CheckAndMark reports whether counter may be accepted and, if so,
// records it. It is not safe for concurrent use; callers must
// serialize access (Registry does this for you).
func (w *Window) CheckAndMark(counter *big.Int) bool {
	if counter == nil || counter.Sign() < 0 {
		return false
	}
	if w.highest == nil {
		w.highest = new(big.Int).Set(counter)
		w.bitmap.SetInt64(1)
		return true
	}
	switch counter.Cmp(w.highest) {
	case 1: // counter > highest: advance, shifting out stale bits
		shift := new(big.Int).Sub(counter, w.highest)
		if !shift.IsUint64() || shift.Uint64() >= w.width {
			// Jump at or beyond the window width: every tracked bit
			// is stale, so only the new counter is marked.
			w.bitmap.SetInt64(1)
		} else {
			w.bitmap.Lsh(w.bitmap, uint(shift.Uint64()))
			w.bitmap.Or(w.bitmap, big.NewInt(1))
		}
		w.highest.Set(counter)
		return true
	default: // counter <= highest: in-window duplicate check
		diff := new(big.Int).Sub(w.highest, counter)
		if !diff.IsUint64() || diff.Uint64() >= w.width {
			return false // older than the window
		}
		bit := int(diff.Uint64())
		if w.bitmap.Bit(bit) != 0 {
			return false // already seen
		}
		w.bitmap.SetBit(w.bitmap, bit, 1)
		return true
	}
}

// Highest returns a copy of the highest accepted counter, or nil if no
// counter has been accepted yet.
func (w *Window) Highest() *big.Int {
	if w.highest == nil {
		return nil
	}
	return new(big.Int).Set(w.highest)
}

// Verifier checks the signature of a request. It must be pure: the
// result must depend only on its arguments.
type Verifier func(clientID string, counter *big.Int, message, signature []byte) bool

// Registry keeps one replay window per client and gates window updates
// behind signature verification. It is safe for concurrent use; in
// particular, concurrent identical requests succeed at most once.
type Registry struct {
	mu      sync.Mutex
	width   uint64
	verify  Verifier
	windows map[string]*Window
}

// NewRegistry returns a Registry with per-client windows of the given
// width. verify may be nil, in which case every request is accepted as
// authentic.
func NewRegistry(width uint64, verify Verifier) *Registry {
	return &Registry{
		width:   width,
		verify:  verify,
		windows: make(map[string]*Window),
	}
}

// Authenticate verifies the request signature and, only on success,
// applies the counter to the client's replay window. It reports
// whether the counter was accepted (first sighting inside the window).
// A signature failure returns ErrBadSignature and never advances the
// window.
func (r *Registry) Authenticate(clientID string, counter *big.Int, message, signature []byte) (bool, error) {
	if counter == nil || counter.Sign() < 0 {
		return false, fmt.Errorf("replay: counter must be a non-negative integer")
	}
	if r.verify != nil && !r.verify(clientID, counter, message, signature) {
		return false, ErrBadSignature
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	w, ok := r.windows[clientID]
	if !ok {
		w = NewWindow(r.width)
		r.windows[clientID] = w
	}
	return w.CheckAndMark(counter), nil
}

// Highest returns the highest accepted counter for clientID, or nil if
// the client is unknown or has not been accepted yet.
func (r *Registry) Highest(clientID string) *big.Int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if w, ok := r.windows[clientID]; ok {
		return w.Highest()
	}
	return nil
}
