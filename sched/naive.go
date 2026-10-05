package sched

// NaiveScheduler is the deliberately simple reference model: it walks
// the virtual clock one round at a time and applies the same policy
// core explicitly. It exists to cross-check ReplayScheduler.
type NaiveScheduler struct {
	core   *core
	events []Event
	evIdx  int
}

// NewNaiveScheduler validates the workload and returns a naive model
// ready to Run.
func NewNaiveScheduler(quantum int64, urgentCap int, events []Event) (*NaiveScheduler, error) {
	c, evs, err := build(quantum, urgentCap, events)
	if err != nil {
		return nil, err
	}
	return &NaiveScheduler{core: c, events: evs}, nil
}

// Run iterates round by round. When completely idle it fast-forwards
// to the next event round, which cannot change any state because no
// tenant is active and quotas only accrue to active tenants.
func (s *NaiveScheduler) Run() {
	c := s.core
	for round := int64(0); ; round++ {
		c.now = round
		for s.evIdx < len(s.events) && s.events[s.evIdx].Round == round {
			c.applyEvent(s.events[s.evIdx])
			s.evIdx++
		}
		c.completeDue()
		if c.idle() {
			if s.evIdx >= len(s.events) {
				return
			}
			round = s.events[s.evIdx].Round - 1 // loop increment lands on it
			continue
		}
		c.addQuantumN(1)
		c.dispatchRound()
	}
}

// Records returns the billing records in the order they were created.
func (s *NaiveScheduler) Records() []Record { return s.core.recordSnapshot() }

// Accounts returns the net credits charged per tenant.
func (s *NaiveScheduler) Accounts() map[string]int64 { return s.core.accountSnapshot() }
