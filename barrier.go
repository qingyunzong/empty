// Package barrier implements a reusable cyclic barrier.
//
// The barrier supports permanent member exit (Leave): a departing member
// counts as arrived for the current round, and subsequent rounds expect one
// fewer member. A wait can be cancelled via context; cancellation revokes
// only that single arrival and never breaks other rounds. Each round is
// released exactly once, and a generation counter prevents stale waiters
// from slipping into a new round.
package barrier

import (
	"context"
	"errors"
	"sync"
)

// ErrNoMembers is returned by Wait when the barrier has no members left.
var ErrNoMembers = errors.New("barrier: no members left")

// Barrier is a cyclic barrier for a dynamic set of members.
//
// The zero value is not usable; construct with New.
type Barrier struct {
	mu       sync.Mutex
	parties  int           // members expected per round from now on
	arrived  int           // arrivals recorded in the current round
	gen      uint64        // current generation (round) counter
	released chan struct{} // closed exactly once when the current round releases
}

// New returns a Barrier expecting parties members per round.
// It panics if parties is not positive.
func New(parties int) *Barrier {
	if parties <= 0 {
		panic("barrier: parties must be positive")
	}
	return &Barrier{
		parties:  parties,
		released: make(chan struct{}),
	}
}

// Wait records an arrival in the current round and blocks until the round
// releases or ctx is done.
//
// If ctx is done before the round releases, only this arrival is revoked and
// ctx.Err() is returned; the round and all other rounds stay intact. If the
// round has already released, Wait returns nil even if ctx is also done.
func Wait(b *Barrier, ctx context.Context) error { return b.Wait(ctx) }

// Wait records an arrival in the current round and blocks until the round
// releases or ctx is done. See the package docs for semantics.
func (b *Barrier) Wait(ctx context.Context) error {
	b.mu.Lock()
	if b.parties == 0 {
		b.mu.Unlock()
		return ErrNoMembers
	}
	gen := b.gen
	ch := b.released
	b.arrived++
	if b.arrived == b.parties {
		b.releaseLocked()
	}
	b.mu.Unlock()

	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		b.mu.Lock()
		if b.gen == gen {
			// Round not released yet: revoke only this arrival.
			b.arrived--
			b.mu.Unlock()
			return ctx.Err()
		}
		b.mu.Unlock()
		// The generation advanced, so our round released; the arrival
		// was consumed by that release and must not be revoked.
		return nil
	}
}

// Leave permanently removes one member from the barrier.
//
// The departure counts as an arrival in the current round and may therefore
// release it; future rounds expect one fewer member. Leave panics if no
// members remain.
func (b *Barrier) Leave() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.parties == 0 {
		panic("barrier: no members left")
	}
	b.arrived++
	b.parties--
	if b.arrived >= b.parties {
		b.releaseLocked()
	}
}

// releaseLocked releases the current round exactly once: it closes the
// generation's channel, installs a fresh channel, resets the arrival count
// and advances the generation so stale waiters can never join the new round.
func (b *Barrier) releaseLocked() {
	close(b.released)
	b.released = make(chan struct{})
	b.arrived = 0
	b.gen++
}

// Generation returns the current generation (round) counter.
func (b *Barrier) Generation() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.gen
}

// Parties returns the number of members expected in future rounds.
func (b *Barrier) Parties() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.parties
}

// Arrived returns the number of arrivals recorded in the current round.
func (b *Barrier) Arrived() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.arrived
}
