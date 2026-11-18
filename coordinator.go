package formal

import (
	"fmt"
	"sort"
	"sync"
	"time"
)

// Config controls the rendezvous coordinator.
type Config struct {
	// GenerationTimeout is the interval between opening a generation and its
	// confirmation deadline. It must be positive.
	GenerationTimeout time.Duration
}

// Coordinator is a deterministic, concurrency-safe rendezvous state machine.
//
// A Coordinator is normally created once by the training launcher and driven
// by membership events from the workers. All mutating methods take the
// caller's current time; the coordinator never reads the wall clock. Callers
// that replay a fault trace can therefore reproduce every deadline decision.
type Coordinator struct {
	mu sync.Mutex

	hasTime bool
	now     time.Time

	timeout        time.Duration
	lastGeneration uint64
	alive          map[MemberID]struct{}
	everJoined     map[MemberID]struct{}
	current        *generationState
	history        []*generationState
}

// New creates an empty coordinator.
func New(cfg Config) (*Coordinator, error) {
	if cfg.GenerationTimeout <= 0 {
		return nil, fmt.Errorf("%w: GenerationTimeout must be positive", ErrInvalidConfig)
	}
	return &Coordinator{
		timeout:    cfg.GenerationTimeout,
		alive:      make(map[MemberID]struct{}),
		everJoined: make(map[MemberID]struct{}),
	}, nil
}

// Join adds a member to the membership view. Joining an already-live member is
// idempotent. A join that changes membership opens a new generation and
// supersedes any pending generation, so old confirmations do not carry over.
func (c *Coordinator) Join(id MemberID, now time.Time) error {
	if id == "" {
		return ErrInvalidMember
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	now = c.observeLocked(now)
	c.expireLocked(now)
	c.everJoined[id] = struct{}{}

	if _, ok := c.alive[id]; ok {
		c.ensureGenerationLocked(now)
		return nil
	}

	c.alive[id] = struct{}{}
	c.openGenerationLocked(now, AbortSuperseded)
	return nil
}

// Reconnect reintroduces a member that previously joined and was removed by a
// failure report or a missed deadline. Reconnecting a live member is
// idempotent. Reconnecting a member that has never joined returns
// ErrUnknownMember.
func (c *Coordinator) Reconnect(id MemberID, now time.Time) error {
	if id == "" {
		return ErrInvalidMember
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	now = c.observeLocked(now)
	c.expireLocked(now)
	defer c.ensureGenerationLocked(now)

	if _, ok := c.alive[id]; ok {
		return nil
	}
	if _, ok := c.everJoined[id]; !ok {
		return fmt.Errorf("%w: %q", ErrUnknownMember, id)
	}

	c.alive[id] = struct{}{}
	c.openGenerationLocked(now, AbortSuperseded)
	return nil
}

// Fail records that a member crashed or was otherwise removed. A pending
// generation is aborted and the remaining members form a new generation. A
// duplicate failure report for a known member is a no-op.
func (c *Coordinator) Fail(id MemberID, now time.Time) error {
	if id == "" {
		return ErrInvalidMember
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	now = c.observeLocked(now)
	c.expireLocked(now)
	defer c.ensureGenerationLocked(now)

	if _, ok := c.alive[id]; !ok {
		if _, known := c.everJoined[id]; known {
			return nil
		}
		return fmt.Errorf("%w: %q", ErrUnknownMember, id)
	}

	delete(c.alive, id)
	c.openGenerationLocked(now, AbortMemberFailed)
	return nil
}

// Ack records a confirmation from id for the identified generation.
//
// The confirmation is accepted only if generation is the current generation,
// id belongs to it, and now is strictly before its deadline. A confirmation
// for an older generation is rejected with ErrStaleGeneration even if the
// member is still alive. Repeating a confirmation for the current generation
// is idempotent.
func (c *Coordinator) Ack(id MemberID, generation uint64, now time.Time) error {
	if id == "" {
		return ErrInvalidMember
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	now = c.observeLocked(now)
	c.expireLocked(now)

	err := c.ackLocked(id, generation, now)
	c.ensureGenerationLocked(now)
	return err
}

// Advance processes deadline expiry at now. If a pending generation misses its
// deadline, non-confirming members are removed and the survivors form a new
// pending generation. Advance is a no-op while a generation is still within
// its deadline or once it has committed.
func (c *Coordinator) Advance(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()

	now = c.observeLocked(now)
	c.expireLocked(now)
	c.ensureGenerationLocked(now)
}

// Current returns the latest generation. It returns false if no generation is
// active, which happens when the last live member is removed.
func (c *Coordinator) Current() (Generation, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.current == nil {
		return Generation{}, false
	}
	return c.current.snapshot(), true
}

// History returns snapshots of every generation opened so far, oldest first.
// The final element is Current when Current reports true.
func (c *Coordinator) History() []Generation {
	c.mu.Lock()
	defer c.mu.Unlock()

	out := make([]Generation, len(c.history))
	for i, generation := range c.history {
		out[i] = generation.snapshot()
	}
	return out
}

func (c *Coordinator) observeLocked(now time.Time) time.Time {
	if !c.hasTime || now.After(c.now) {
		c.now = now
		c.hasTime = true
	}
	return c.now
}

// expireLocked aborts a pending generation whose deadline has been reached.
// Only members that confirmed before the deadline survive. A replacement
// generation is deliberately not opened here: the event currently being
// processed decides the final membership, so one event never creates two
// generations.
func (c *Coordinator) expireLocked(now time.Time) bool {
	if c.current == nil || c.current.state != GenerationPending {
		return false
	}
	if now.Before(c.current.deadline) {
		return false
	}

	survivors := make(map[MemberID]struct{}, len(c.current.confirmations))
	for id := range c.current.confirmations {
		if _, ok := c.current.memberSet[id]; ok {
			survivors[id] = struct{}{}
		}
	}

	c.current.state = GenerationAborted
	c.current.abortReason = AbortDeadline
	c.current = nil
	c.alive = survivors
	return true
}

// openGenerationLocked aborts any still-pending generation and opens a
// generation over the current live membership. It is a no-op when no members
// remain, in which case there is no current generation.
func (c *Coordinator) openGenerationLocked(now time.Time, pendingAbort AbortReason) {
	if c.current != nil && c.current.state == GenerationPending {
		c.current.state = GenerationAborted
		c.current.abortReason = pendingAbort
		c.current = nil
	}

	if len(c.alive) == 0 {
		c.current = nil
		return
	}

	c.lastGeneration++
	generation := newGenerationState(c.lastGeneration, now, c.timeout, c.alive)
	c.current = generation
	c.history = append(c.history, generation)
}

// ensureGenerationLocked restores the invariant that a non-empty live
// membership has a current generation. It is used after deadline expiry,
// where the replacement generation must be created before the triggering
// event returns its result.
func (c *Coordinator) ensureGenerationLocked(now time.Time) {
	if c.current == nil && len(c.alive) > 0 {
		c.openGenerationLocked(now, AbortSuperseded)
	}
}

func (c *Coordinator) ackLocked(id MemberID, generation uint64, now time.Time) error {
	if c.current == nil {
		if c.lastGeneration == 0 {
			return ErrNoGeneration
		}
		if generation <= c.lastGeneration {
			return fmt.Errorf("%w: generation %d is closed", ErrStaleGeneration, generation)
		}
		return fmt.Errorf("%w: generation %d", ErrUnknownGeneration, generation)
	}

	current := c.current
	switch {
	case generation < current.number:
		return fmt.Errorf("%w: generation %d, current %d", ErrStaleGeneration, generation, current.number)
	case generation > current.number:
		return fmt.Errorf("%w: generation %d, current %d", ErrUnknownGeneration, generation, current.number)
	}

	if _, ok := current.memberSet[id]; !ok {
		return fmt.Errorf("%w: %q in generation %d", ErrNotMember, id, generation)
	}

	if _, confirmed := current.confirmations[id]; confirmed {
		return nil
	}
	if current.state != GenerationPending {
		return fmt.Errorf("%w: generation %d is %s", ErrGenerationClosed, generation, current.state)
	}

	current.confirmations[id] = now
	if len(current.confirmations) == len(current.members) {
		current.state = GenerationCommitted
	}
	return nil
}

// Members returns the live member IDs in canonical rank order. It is a
// convenience for launchers that only need the current membership table.
func (c *Coordinator) Members() []MemberID {
	c.mu.Lock()
	defer c.mu.Unlock()

	ids := make([]MemberID, 0, len(c.alive))
	for id := range c.alive {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}
