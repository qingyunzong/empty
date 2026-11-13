package dataeng

import (
	"errors"
	"time"
)

var (
	// ErrUnknownSlot is returned when an operation targets a sequence that was
	// never reserved.
	ErrUnknownSlot = errors.New("dataeng: unknown outbox slot")
	// ErrNotCommitted is returned when committing a slot that is not in the
	// reserved state, for example a slot already committed.
	ErrNotCommitted = errors.New("dataeng: slot is not awaiting commit")
	// ErrNotDispatched is returned when acknowledging a slot that has never
	// been dispatched.
	ErrNotDispatched = errors.New("dataeng: slot has not been dispatched")
	// ErrAlreadyAcknowledged is returned when acknowledging a slot that was
	// already acknowledged, including acknowledgement with an older generation.
	ErrAlreadyAcknowledged = errors.New("dataeng: slot already acknowledged")
	// ErrStaleGeneration is returned when an acknowledgement carries a
	// generation older than the one currently in flight. A stale
	// acknowledgement is ignored and never changes the slot.
	ErrStaleGeneration = errors.New("dataeng: stale acknowledgement generation")
	// ErrUnknownGeneration is returned when an acknowledgement carries a
	// generation that has not been issued for the slot.
	ErrUnknownGeneration = errors.New("dataeng: unknown acknowledgement generation")
)

// Clock is the time source consulted when deciding whether a dispatched slot
// has timed out. Tests can pass a fully controllable implementation; no wall
// clock is used internally.
type Clock interface {
	Now() time.Time
}

// slotState is the lifecycle stage of an outbox slot.
type slotState int

const (
	// stateReserved: reserved inside a transaction that has not committed yet.
	stateReserved slotState = iota
	// stateCommitted: transaction committed; eligible for dispatch.
	stateCommitted
	// stateInFlight: dispatched and waiting for an acknowledgement.
	stateInFlight
	// stateAcknowledged: a matching acknowledgement was received.
	stateAcknowledged
)

// slot holds the per-sequence tracking state. Sequences are stored implicitly
// as slice index plus one and are never reused.
type slot struct {
	state      slotState
	generation int64
	dispatched time.Time
}

// Dispatch identifies a slot a caller should deliver. Generation is
// incremented on every dispatch, including redispatch after a timeout, so the
// acknowledgement can be matched against the exact in-flight attempt.
type Dispatch struct {
	Sequence   int64
	Generation int64
}

// Tracker records outbox slots without performing any message delivery.
type Tracker struct {
	clock   Clock
	timeout time.Duration
	slots   []slot
}

// NewTracker creates a Tracker. A slot is considered timed out once at least
// timeout has elapsed since its most recent dispatch, as observed on clock.
func NewTracker(clock Clock, timeout time.Duration) *Tracker {
	return &Tracker{
		clock:   clock,
		timeout: timeout,
	}
}

// Reserve allocates the next slot sequence. Sequences start at one and are
// strictly increasing; abandoned reservations permanently leave a gap that no
// later sequence fills.
func (t *Tracker) Reserve() int64 {
	t.slots = append(t.slots, slot{state: stateReserved})
	return int64(len(t.slots))
}

// Commit marks a reserved slot as committed. Only committed slots can be
// dispatched.
func (t *Tracker) Commit(sequence int64) error {
	entry, err := t.lookup(sequence)
	if err != nil {
		return err
	}
	if entry.state != stateReserved {
		return ErrNotCommitted
	}
	entry.state = stateCommitted
	return nil
}

// Poll returns every slot currently ready for delivery, ordered by sequence.
// A committed slot is dispatched for the first time with generation one. An
// in-flight slot is redispatched, with the same sequence and a fresh
// generation, only once the clock reports that its timeout has elapsed.
// Acknowledged slots and slots still reserved are never returned.
func (t *Tracker) Poll() []Dispatch {
	now := t.clock.Now()
	ready := make([]Dispatch, 0)
	for index := range t.slots {
		entry := &t.slots[index]
		switch entry.state {
		case stateCommitted:
			entry.generation++
			entry.dispatched = now
			entry.state = stateInFlight
			ready = append(ready, Dispatch{
				Sequence:   int64(index + 1),
				Generation: entry.generation,
			})
		case stateInFlight:
			if now.Sub(entry.dispatched) < t.timeout {
				continue
			}
			entry.generation++
			entry.dispatched = now
			ready = append(ready, Dispatch{
				Sequence:   int64(index + 1),
				Generation: entry.generation,
			})
		}
	}
	return ready
}

// Ack acknowledges a dispatch attempt. The generation must equal the
// generation currently in flight: older generations are rejected with
// ErrStaleGeneration and leave the slot untouched, so a late acknowledgement
// for an attempt that was already redispatched cannot acknowledge the new
// attempt.
func (t *Tracker) Ack(sequence, generation int64) error {
	entry, err := t.lookup(sequence)
	if err != nil {
		return err
	}
	switch entry.state {
	case stateReserved, stateCommitted:
		return ErrNotDispatched
	case stateAcknowledged:
		if generation == entry.generation {
			return nil
		}
		return ErrAlreadyAcknowledged
	}
	switch {
	case generation == entry.generation:
		entry.state = stateAcknowledged
		return nil
	case generation < entry.generation:
		return ErrStaleGeneration
	default:
		return ErrUnknownGeneration
	}
}

// lookup returns the slot backing a one-based sequence.
func (t *Tracker) lookup(sequence int64) (*slot, error) {
	if sequence < 1 || sequence > int64(len(t.slots)) {
		return nil, ErrUnknownSlot
	}
	return &t.slots[sequence-1], nil
}
