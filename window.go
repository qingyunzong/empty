// Package authreplay implements a sliding-window replay-protection
// authenticator. Each client is tracked by a monotonically increasing
// counter; a W-bit bitmap records which of the last W counter values
// have already been seen.
package authreplay

import (
	"errors"
	"fmt"
	"sync"
)

// MaxWidth is the largest supported window width.
const MaxWidth = 64

// ErrBadWidth is returned by NewAuthenticator for unsupported widths.
var ErrBadWidth = errors.New("authreplay: width must be between 1 and 64")

// clientState holds the replay window of a single client.
type clientState struct {
	mu      sync.Mutex
	started bool   // false until the first accepted request
	highest uint64 // highest accepted counter so far
	bits    uint64 // bit i set => counter (highest - i) already accepted
}

// accept reports whether counter may be accepted and, if so, records it.
// The caller must have verified the request signature already; this
// method mutates state unconditionally on success.
func (c *clientState) accept(counter uint64, width uint64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.started {
		c.started = true
		c.highest = counter
		c.bits = 1
		return true
	}

	if counter > c.highest {
		// Forward jump: shift the window, discarding bits that fall
		// off the left edge. A jump of width or more clears everything.
		shift := counter - c.highest
		if shift >= width {
			c.bits = 1
		} else {
			c.bits = c.bits<<shift | 1
		}
		c.highest = counter
		return true
	}

	// counter <= c.highest: inside or behind the window.
	diff := c.highest - counter // cannot underflow
	if diff >= width {
		return false // too old, outside the window
	}
	mask := uint64(1) << diff
	if c.bits&mask != 0 {
		return false // duplicate
	}
	c.bits |= mask
	return true
}

// Authenticator tracks per-client replay windows of a fixed width.
type Authenticator struct {
	width uint64

	mu      sync.Mutex
	clients map[string]*clientState
}

// NewAuthenticator returns an Authenticator with a window of width bits.
func NewAuthenticator(width uint) (*Authenticator, error) {
	if width < 1 || width > MaxWidth {
		return nil, fmt.Errorf("%w, got %d", ErrBadWidth, width)
	}
	return &Authenticator{
		width:   uint64(width),
		clients: make(map[string]*clientState),
	}, nil
}

// MustAuthenticator is like NewAuthenticator but panics on a bad width.
func MustAuthenticator(width uint) *Authenticator {
	a, err := NewAuthenticator(width)
	if err != nil {
		panic(err)
	}
	return a
}

// Verify processes one request from clientID carrying the given counter.
// signatureOK must be the result of verifying the request signature.
//
// A request is accepted only if its signature is valid and its counter
// is fresh (never accepted before and not older than the window).
// Failed signature verification never advances or otherwise mutates the
// window. Concurrent calls are safe; identical concurrent requests are
// accepted at most once.
func (a *Authenticator) Verify(clientID string, counter uint64, signatureOK bool) bool {
	if !signatureOK {
		return false
	}
	a.mu.Lock()
	cs, ok := a.clients[clientID]
	if !ok {
		cs = &clientState{}
		a.clients[clientID] = cs
	}
	a.mu.Unlock()
	return cs.accept(counter, a.width)
}

// Highest returns the highest accepted counter for clientID and whether
// any request has been accepted for that client.
func (a *Authenticator) Highest(clientID string) (uint64, bool) {
	a.mu.Lock()
	cs, ok := a.clients[clientID]
	a.mu.Unlock()
	if !ok {
		return 0, false
	}
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return cs.highest, cs.started
}
