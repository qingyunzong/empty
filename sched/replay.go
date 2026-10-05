package sched

// ReplayScheduler is an event-driven driver over the policy core.
// Instead of visiting every round, it jumps the virtual clock to the
// next round that can change state (an external event, a task
// completion, or the round some tenant's deficit reaches its head
// task's cost) and credits the skipped rounds' integer quotas in one
// shot. Skipping is sound because between two such rounds no queue
// changes, no task becomes affordable, and the active tenant set is
// constant, so per-round quota accumulation is linear.
type ReplayScheduler struct {
	core   *core
	events []Event
	evIdx  int
}

// NewReplayScheduler validates the workload and returns a scheduler
// ready to Run. urgentCap is the maximum number of urgent tasks
// injected per round (use 2 for the classic "at most two" policy).
func NewReplayScheduler(quantum int64, urgentCap int, events []Event) (*ReplayScheduler, error) {
	c, evs, err := build(quantum, urgentCap, events)
	if err != nil {
		return nil, err
	}
	return &ReplayScheduler{core: c, events: evs}, nil
}

// Run replays the workload on the virtual clock until every queue is
// drained, every running task has finished, and no events remain.
func (s *ReplayScheduler) Run() {
	c := s.core
	for {
		for s.evIdx < len(s.events) && s.events[s.evIdx].Round == c.now {
			c.applyEvent(s.events[s.evIdx])
			s.evIdx++
		}
		c.completeDue()
		if c.idle() && s.evIdx >= len(s.events) {
			return
		}
		c.addQuantumN(1)
		c.dispatchRound()

		next := int64(-1)
		consider := func(r int64) {
			if r > c.now && (next == -1 || r < next) {
				next = r
			}
		}
		if s.evIdx < len(s.events) {
			consider(s.events[s.evIdx].Round)
		}
		if f, ok := c.minFinish(); ok {
			consider(f)
		}
		if k, ok := c.roundsUntilAffordable(); ok {
			consider(c.now + k)
		}
		if len(c.urgent) > 0 {
			consider(c.now + 1) // urgent backlog waits for the next round's cap
		}
		if next == -1 {
			return // unreachable while not idle, but stay safe
		}
		// Credit the skipped rounds' quotas with the current (constant)
		// active tenant set, then jump the virtual clock.
		c.addQuantumN(next - c.now - 1)
		c.now = next
	}
}

// Records returns the billing records in the order they were created.
func (s *ReplayScheduler) Records() []Record { return s.core.recordSnapshot() }

// Accounts returns the net credits charged per tenant.
func (s *ReplayScheduler) Accounts() map[string]int64 { return s.core.accountSnapshot() }
