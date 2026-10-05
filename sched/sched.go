// Package sched implements a tenant round-robin batch scheduler.
//
// Scheduling model (deficit round robin):
//   - Every round, each tenant with a non-empty queue receives a fixed
//     integer quota (quantum) added to its deficit counter.
//   - A queued task may dispatch once its tenant's deficit covers the
//     task cost, so tasks costing more than one quantum accumulate
//     credit across rounds.
//   - Urgent tasks live in a global FIFO queue and bypass the deficit,
//     but at most urgentCap of them are injected per round.
//   - Cancelling a queued task is free; cancelling a running task
//     refunds the unconsumed fraction, so a cancel never leaves a
//     phantom charge behind.
//
// The package provides two drivers over the same policy core:
// ReplayScheduler (event-driven, jumps the virtual clock across idle
// rounds) and NaiveScheduler (iterates every round explicitly). They
// are cross-checked for equivalence in the tests.
package sched

import (
	"fmt"
	"sort"
)

// Task is a unit of batch work.
type Task struct {
	ID       string
	Tenant   string
	Cost     int64 // credits charged when dispatched
	Duration int64 // rounds the task occupies the executor once dispatched
	Urgent   bool  // urgent tasks bypass the deficit, capped per round
}

// EventKind discriminates Event.
type EventKind int

const (
	// Submit submits Event.Task at Event.Round.
	Submit EventKind = iota
	// Cancel cancels Event.TaskID at Event.Round.
	Cancel
)

// Event is an external occurrence at a virtual-clock round.
type Event struct {
	Round  int64
	Kind   EventKind
	Task   Task   // for Submit
	TaskID string // for Cancel
}

// Record is the billing and lifecycle record of one submitted task.
type Record struct {
	TaskID        string
	Tenant        string
	Urgent        bool
	DispatchRound int64 // -1 if never dispatched
	FinishRound   int64 // completion round, or cancel round if cancelled while running; -1 if cancelled while queued
	Cancelled     bool
	Charged       int64 // net credits charged (0 when cancelled while queued)
}

type tenant struct {
	queue   []Task
	deficit int64
}

type runState struct {
	task   Task
	finish int64
}

// core holds the scheduling policy shared by both drivers.
type core struct {
	quantum   int64
	urgentCap int
	now       int64

	tenants  map[string]*tenant
	order    []string // tenant registration order (round-robin ring)
	cursor   int
	urgent   []Task
	running  map[string]*runState
	accounts map[string]int64
	records  []*Record
	byID     map[string]*Record
}

// build validates inputs and returns an initialized core plus the
// events stably sorted by round.
func build(quantum int64, urgentCap int, events []Event) (*core, []Event, error) {
	if quantum < 1 {
		return nil, nil, fmt.Errorf("sched: quantum must be >= 1, got %d", quantum)
	}
	if urgentCap < 1 {
		return nil, nil, fmt.Errorf("sched: urgent cap must be >= 1, got %d", urgentCap)
	}
	evs := make([]Event, len(events))
	copy(evs, events)
	sort.SliceStable(evs, func(i, j int) bool { return evs[i].Round < evs[j].Round })
	seen := make(map[string]bool)
	for _, e := range evs {
		if e.Round < 0 {
			return nil, nil, fmt.Errorf("sched: negative event round %d", e.Round)
		}
		switch e.Kind {
		case Submit:
			t := e.Task
			if t.ID == "" || t.Tenant == "" {
				return nil, nil, fmt.Errorf("sched: task needs ID and Tenant: %+v", t)
			}
			if t.Cost < 1 || t.Duration < 1 {
				return nil, nil, fmt.Errorf("sched: task %s needs Cost >= 1 and Duration >= 1", t.ID)
			}
			if seen[t.ID] {
				return nil, nil, fmt.Errorf("sched: duplicate task ID %q", t.ID)
			}
			seen[t.ID] = true
		case Cancel:
			if e.TaskID == "" {
				return nil, nil, fmt.Errorf("sched: cancel event at round %d has empty task ID", e.Round)
			}
		default:
			return nil, nil, fmt.Errorf("sched: unknown event kind %d", e.Kind)
		}
	}
	c := &core{
		quantum:   quantum,
		urgentCap: urgentCap,
		tenants:   make(map[string]*tenant),
		running:   make(map[string]*runState),
		accounts:  make(map[string]int64),
		byID:      make(map[string]*Record),
	}
	return c, evs, nil
}

func (c *core) tenantOf(id string) *tenant {
	tn, ok := c.tenants[id]
	if !ok {
		tn = &tenant{}
		c.tenants[id] = tn
		c.order = append(c.order, id)
	}
	return tn
}

// addQuantumN credits every active tenant for n elapsed rounds.
func (c *core) addQuantumN(n int64) {
	if n <= 0 {
		return
	}
	for _, id := range c.order {
		tn := c.tenants[id]
		if len(tn.queue) > 0 {
			tn.deficit += c.quantum * n
		}
	}
}

// dispatchRound injects up to urgentCap urgent tasks, then sweeps the
// tenant ring until no tenant can afford its head task.
func (c *core) dispatchRound() {
	used := 0
	for {
		if len(c.urgent) > 0 && used < c.urgentCap {
			t := c.urgent[0]
			c.urgent = c.urgent[1:]
			c.dispatch(t)
			used++
			continue
		}
		if !c.sweepOnce() {
			return
		}
	}
}

// sweepOnce dispatches the head task of the next tenant (in ring
// order) whose deficit covers it. Returns false when nobody can pay.
func (c *core) sweepOnce() bool {
	n := len(c.order)
	for i := 0; i < n; i++ {
		idx := (c.cursor + i) % n
		tn := c.tenants[c.order[idx]]
		if len(tn.queue) == 0 || tn.queue[0].Cost > tn.deficit {
			continue
		}
		t := tn.queue[0]
		tn.queue = tn.queue[1:]
		tn.deficit -= t.Cost
		if len(tn.queue) == 0 {
			tn.deficit = 0 // deficit round robin: no hoarding on empty queue
		}
		c.cursor = (idx + 1) % n
		c.dispatch(t)
		return true
	}
	return false
}

func (c *core) dispatch(t Task) {
	rec := &Record{
		TaskID:        t.ID,
		Tenant:        t.Tenant,
		Urgent:        t.Urgent,
		DispatchRound: c.now,
		FinishRound:   c.now + t.Duration,
		Charged:       t.Cost,
	}
	c.records = append(c.records, rec)
	c.byID[t.ID] = rec
	c.accounts[t.Tenant] += t.Cost
	c.running[t.ID] = &runState{task: t, finish: c.now + t.Duration}
}

func (c *core) applyEvent(e Event) {
	switch e.Kind {
	case Submit:
		if e.Task.Urgent {
			c.urgent = append(c.urgent, e.Task)
		} else {
			tn := c.tenantOf(e.Task.Tenant)
			tn.queue = append(tn.queue, e.Task)
		}
	case Cancel:
		c.cancel(e.TaskID)
	}
}

// cancel removes a queued task for free, or stops a running task and
// refunds the unconsumed fraction of its cost. Cancelling a queued
// task never touches the account, so no phantom charge remains.
func (c *core) cancel(id string) {
	for _, tid := range c.order {
		tn := c.tenants[tid]
		for i, t := range tn.queue {
			if t.ID != id {
				continue
			}
			tn.queue = append(tn.queue[:i], tn.queue[i+1:]...)
			if len(tn.queue) == 0 {
				tn.deficit = 0
			}
			c.records = append(c.records, &Record{
				TaskID: id, Tenant: t.Tenant, Urgent: t.Urgent,
				DispatchRound: -1, FinishRound: -1, Cancelled: true, Charged: 0,
			})
			return
		}
	}
	for i, t := range c.urgent {
		if t.ID != id {
			continue
		}
		c.urgent = append(c.urgent[:i], c.urgent[i+1:]...)
		c.records = append(c.records, &Record{
			TaskID: id, Tenant: t.Tenant, Urgent: true,
			DispatchRound: -1, FinishRound: -1, Cancelled: true, Charged: 0,
		})
		return
	}
	if rs, ok := c.running[id]; ok {
		delete(c.running, id)
		remaining := rs.finish - c.now
		refund := rs.task.Cost * remaining / rs.task.Duration
		c.accounts[rs.task.Tenant] -= refund
		rec := c.byID[id]
		rec.Cancelled = true
		rec.FinishRound = c.now
		rec.Charged -= refund
	}
}

// completeDue retires running tasks whose finish round has arrived.
func (c *core) completeDue() {
	for id, rs := range c.running {
		if rs.finish <= c.now {
			delete(c.running, id)
		}
	}
}

func (c *core) idle() bool {
	if len(c.running) > 0 || len(c.urgent) > 0 {
		return false
	}
	for _, id := range c.order {
		if len(c.tenants[id].queue) > 0 {
			return false
		}
	}
	return true
}

func (c *core) minFinish() (int64, bool) {
	var best int64
	ok := false
	for _, rs := range c.running {
		if !ok || rs.finish < best {
			best = rs.finish
			ok = true
		}
	}
	return best, ok
}

// roundsUntilAffordable returns how many further rounds of quantum
// accumulation the most nearly affordable queued task needs.
func (c *core) roundsUntilAffordable() (int64, bool) {
	var best int64
	found := false
	for _, id := range c.order {
		tn := c.tenants[id]
		if len(tn.queue) == 0 {
			continue
		}
		need := tn.queue[0].Cost - tn.deficit
		k := int64(0)
		if need > 0 {
			k = (need + c.quantum - 1) / c.quantum
		}
		if k < 1 {
			k = 1
		}
		if !found || k < best {
			best = k
			found = true
		}
	}
	return best, found
}

func (c *core) recordSnapshot() []Record {
	out := make([]Record, len(c.records))
	for i, r := range c.records {
		out[i] = *r
	}
	return out
}

func (c *core) accountSnapshot() map[string]int64 {
	out := make(map[string]int64, len(c.accounts))
	for k, v := range c.accounts {
		out[k] = v
	}
	return out
}
