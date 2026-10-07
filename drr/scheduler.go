// Package drr implements a deficit round-robin (DRR) scheduler for
// multi-tenant workloads.
//
// Each round, every active tenant (one with a non-empty queue) is credited
// an integer quota equal to its current weight. While the head task's cost
// fits the tenant's deficit counter, the task is served and the cost is
// deducted; otherwise the deficit carries over and accumulates into the
// next round. When a tenant's queue drains, its deficit resets to zero.
// Tasks with negative cost are rejected. Weight updates take effect at the
// start of the next round. Every deduction is recorded in a ledger.
package drr

import "errors"

var (
	ErrUnknownTenant = errors.New("drr: unknown tenant")
	ErrTenantExists  = errors.New("drr: tenant already exists")
	ErrInvalidWeight = errors.New("drr: weight must be a positive integer")
	ErrNegativeCost  = errors.New("drr: task cost must not be negative")
)

// Task is a unit of work waiting in a tenant's queue.
type Task struct {
	ID   string
	Cost int64
}

// LedgerEntry records a single deduction: one served task.
type LedgerEntry struct {
	Round         int
	Tenant        string
	Task          string
	Cost          int64
	Weight        int64 // tenant weight in effect for this round
	DeficitBefore int64
	DeficitAfter  int64
}

type tenant struct {
	id         string
	weight     int64 // weight in effect for the current round
	nextWeight int64 // weight that takes effect next round
	deficit    int64
	queue      []Task
	active     bool
}

// Scheduler is a deficit round-robin scheduler over tenant queues.
type Scheduler struct {
	tenants map[string]*tenant
	active  []*tenant // round-robin list of tenants with non-empty queues
	round   int
	ledger  []LedgerEntry
}

// New returns an empty Scheduler.
func New() *Scheduler {
	return &Scheduler{tenants: make(map[string]*tenant)}
}

// AddTenant registers a tenant with the given positive integer weight.
func (s *Scheduler) AddTenant(id string, weight int64) error {
	if weight <= 0 {
		return ErrInvalidWeight
	}
	if _, ok := s.tenants[id]; ok {
		return ErrTenantExists
	}
	s.tenants[id] = &tenant{id: id, weight: weight, nextWeight: weight}
	return nil
}

// SetWeight schedules a weight update that takes effect at the start of
// the next round.
func (s *Scheduler) SetWeight(id string, weight int64) error {
	if weight <= 0 {
		return ErrInvalidWeight
	}
	t, ok := s.tenants[id]
	if !ok {
		return ErrUnknownTenant
	}
	t.nextWeight = weight
	return nil
}

// Enqueue appends a task to a tenant's queue. Negative costs are rejected.
func (s *Scheduler) Enqueue(id string, task Task) error {
	if task.Cost < 0 {
		return ErrNegativeCost
	}
	t, ok := s.tenants[id]
	if !ok {
		return ErrUnknownTenant
	}
	t.queue = append(t.queue, task)
	if !t.active {
		t.active = true
		s.active = append(s.active, t)
	}
	return nil
}

// RunRound executes one scheduling round and returns the ledger entries
// produced during it.
func (s *Scheduler) RunRound() []LedgerEntry {
	s.round++
	for _, t := range s.tenants {
		t.weight = t.nextWeight
	}
	start := len(s.ledger)
	for i := 0; i < len(s.active); {
		t := s.active[i]
		t.deficit += t.weight
		for len(t.queue) > 0 && t.queue[0].Cost <= t.deficit {
			task := t.queue[0]
			before := t.deficit
			t.deficit -= task.Cost
			t.queue = t.queue[1:]
			s.ledger = append(s.ledger, LedgerEntry{
				Round:         s.round,
				Tenant:        t.id,
				Task:          task.ID,
				Cost:          task.Cost,
				Weight:        t.weight,
				DeficitBefore: before,
				DeficitAfter:  t.deficit,
			})
		}
		if len(t.queue) == 0 {
			t.deficit = 0
			t.active = false
			s.active = append(s.active[:i], s.active[i+1:]...)
		} else {
			i++
		}
	}
	return s.ledger[start:]
}

// Run executes n rounds.
func (s *Scheduler) Run(n int) {
	for i := 0; i < n; i++ {
		s.RunRound()
	}
}

// Ledger returns a copy of every deduction recorded so far, in order.
func (s *Scheduler) Ledger() []LedgerEntry {
	out := make([]LedgerEntry, len(s.ledger))
	copy(out, s.ledger)
	return out
}

// Round returns the number of rounds executed so far.
func (s *Scheduler) Round() int { return s.round }

// Deficit returns the tenant's current deficit counter.
func (s *Scheduler) Deficit(id string) (int64, error) {
	t, ok := s.tenants[id]
	if !ok {
		return 0, ErrUnknownTenant
	}
	return t.deficit, nil
}

// QueueLen returns the number of tasks waiting in the tenant's queue.
func (s *Scheduler) QueueLen(id string) (int, error) {
	t, ok := s.tenants[id]
	if !ok {
		return 0, ErrUnknownTenant
	}
	return len(t.queue), nil
}

// Weight returns the weight currently in effect for the tenant.
func (s *Scheduler) Weight(id string) (int64, error) {
	t, ok := s.tenants[id]
	if !ok {
		return 0, ErrUnknownTenant
	}
	return t.weight, nil
}
