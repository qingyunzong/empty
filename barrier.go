// Package barrier implements a reusable cyclic barrier with named members.
//
// Features:
//   - Members may permanently exit: an exiting member counts as arrived for
//     the current round, and the next round expects one fewer party.
//   - Cancelling a wait (via context) only undoes that single arrival; it
//     never breaks the barrier or poisons other rounds.
//   - Each round is released exactly once.
//   - A generation counter prevents stale waiters from a released round from
//     interfering with the new round.
//   - The per-round arrival history is recorded and can be enumerated.
package barrier

import (
	"context"
	"errors"
	"sync"
)

var (
	// ErrUnknownMember is returned when a member ID is not registered.
	ErrUnknownMember = errors.New("barrier: unknown member")
	// ErrDuplicateArrival is returned when a member arrives twice in one round.
	ErrDuplicateArrival = errors.New("barrier: member already arrived this round")
	// ErrNoParties is returned when awaiting on a barrier with no members left.
	ErrNoParties = errors.New("barrier: no parties remaining")
)

// RoundRecord describes one completed round (generation) of the barrier.
type RoundRecord struct {
	// Generation is the zero-based generation number of the round.
	Generation uint64
	// Arrived lists the members counted as arrived, in arrival order.
	// It includes members whose permanent exit counted as an arrival.
	Arrived []string
	// Exited lists the members whose permanent exit counted as an
	// arrival in this round.
	Exited []string
}

// Barrier is a cyclic barrier for a fixed but shrinkable set of named members.
type Barrier struct {
	mu      sync.Mutex
	members map[string]bool // currently registered members
	parties int             // arrivals required to release the current round
	arrived map[string]bool // arrivals in the current generation
	order   []string        // arrival order in the current generation
	exited  []string        // exits counted as arrivals in the current generation
	gen     uint64          // current generation
	ch      chan struct{}   // closed when the current generation is released
	history []RoundRecord   // completed rounds, in order
}

// New creates a barrier expecting the given members. Each member ID must be
// unique and non-empty.
func New(memberIDs ...string) *Barrier {
	b := &Barrier{
		members: make(map[string]bool, len(memberIDs)),
		arrived: make(map[string]bool, len(memberIDs)),
		ch:      make(chan struct{}),
	}
	for _, id := range memberIDs {
		if !b.members[id] {
			b.members[id] = true
			b.parties++
		}
	}
	return b
}

// Await records the arrival of member id for the current round and blocks
// until the round is released or ctx is done.
//
// If ctx is done before the round is released, only this arrival is undone;
// the barrier itself is not broken and other rounds are unaffected. If the
// round has already been released, cancellation cannot touch the new
// generation.
//
// It returns the generation the caller participated in.
func (b *Barrier) Await(ctx context.Context, id string) (uint64, error) {
	b.mu.Lock()
	if !b.members[id] {
		b.mu.Unlock()
		return 0, ErrUnknownMember
	}
	if b.parties == 0 {
		b.mu.Unlock()
		return 0, ErrNoParties
	}
	if b.arrived[id] {
		b.mu.Unlock()
		return 0, ErrDuplicateArrival
	}
	b.arrived[id] = true
	b.order = append(b.order, id)
	gen := b.gen
	ch := b.ch
	b.maybeReleaseLocked()
	b.mu.Unlock()

	select {
	case <-ch:
		return gen, nil
	case <-ctx.Done():
		b.mu.Lock()
		// Undo the arrival only if this generation is still open and the
		// arrival is still recorded. Once the generation advanced, the
		// stale cancellation must not touch the new round.
		if b.gen == gen && b.arrived[id] {
			delete(b.arrived, id)
			for i, m := range b.order {
				if m == id {
					b.order = append(b.order[:i], b.order[i+1:]...)
					break
				}
			}
		}
		b.mu.Unlock()
		return gen, ctx.Err()
	}
}

// Exit permanently removes member id from the barrier. The exit counts as an
// arrival for the current round (unless the member already arrived), so the
// current round can still complete; from the next round on, one fewer party
// is expected.
func (b *Barrier) Exit(id string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.members[id] {
		return ErrUnknownMember
	}
	delete(b.members, id)
	b.parties--
	if !b.arrived[id] {
		b.arrived[id] = true
		b.order = append(b.order, id)
		b.exited = append(b.exited, id)
	}
	b.maybeReleaseLocked()
	return nil
}

// maybeReleaseLocked releases the current round exactly once when all
// parties have arrived. It must be called with b.mu held.
func (b *Barrier) maybeReleaseLocked() {
	if b.parties == 0 || len(b.arrived) < b.parties {
		return
	}
	b.history = append(b.history, RoundRecord{
		Generation: b.gen,
		Arrived:    append([]string(nil), b.order...),
		Exited:     append([]string(nil), b.exited...),
	})
	close(b.ch) // the one and only release of this generation
	b.gen++
	b.ch = make(chan struct{})
	b.arrived = make(map[string]bool, b.parties)
	b.order = nil
	b.exited = nil
}

// Parties returns the number of arrivals expected in the current round.
func (b *Barrier) Parties() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.parties
}

// Generation returns the current generation number.
func (b *Barrier) Generation() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.gen
}

// History returns a copy of the records of all completed rounds.
func (b *Barrier) History() []RoundRecord {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]RoundRecord(nil), b.history...)
}
