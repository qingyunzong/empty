// Package locksim simulates mutual-exclusion locks with priority
// inheritance (priority donation).
//
// The simulator is driven by events: a task requests a lock, releases a
// lock, or changes its base priority. After every event the effective
// priorities of all tasks are recomputed as a least fixed point:
//
//	eff[T] = max(base[T], max{ eff[W] : W waits on a lock held by T })
//
// Because effective priorities only increase during iteration and are
// bounded above by the maximum base priority, the recomputation always
// terminates — even when the wait-for graph contains a cycle (deadlock).
// A request that closes a wait-for cycle is reported as a *CycleError
// carrying the cycle, instead of looping forever.
package locksim

import (
	"fmt"
	"strings"
)

// CycleError is returned by Request when the new wait edge closes a
// wait-for cycle (deadlock). Cycle lists the involved task IDs in wait
// order: Cycle[i] waits on a lock held by Cycle[i+1], and the last task
// waits on a lock held by the first.
type CycleError struct {
	Cycle []string
}

func (e *CycleError) Error() string {
	return "deadlock: wait-for cycle " + strings.Join(append(append([]string{}, e.Cycle...), e.Cycle[0]), " -> ")
}

type task struct {
	id      string
	base    int
	eff     int
	waitsOn *lock
}

type lock struct {
	id      string
	holder  *task
	waiters []*task
}

// Simulator maintains tasks, locks and their donated priorities.
type Simulator struct {
	tasks map[string]*task
	locks map[string]*lock
}

// New returns an empty simulator.
func New() *Simulator {
	return &Simulator{
		tasks: make(map[string]*task),
		locks: make(map[string]*lock),
	}
}

// AddTask registers a task with the given base priority.
// Larger values mean higher priority.
func (s *Simulator) AddTask(id string, base int) error {
	if _, ok := s.tasks[id]; ok {
		return fmt.Errorf("task %q already exists", id)
	}
	s.tasks[id] = &task{id: id, base: base, eff: base}
	return nil
}

// AddLock registers a lock.
func (s *Simulator) AddLock(id string) error {
	if _, ok := s.locks[id]; ok {
		return fmt.Errorf("lock %q already exists", id)
	}
	s.locks[id] = &lock{id: id}
	return nil
}

// SetBasePriority changes a task's base priority and recomputes
// effective priorities.
func (s *Simulator) SetBasePriority(taskID string, p int) error {
	t, ok := s.tasks[taskID]
	if !ok {
		return fmt.Errorf("unknown task %q", taskID)
	}
	t.base = p
	s.recompute()
	return nil
}

// Request makes taskID try to acquire lockID. If the lock is free the
// task becomes its holder. Otherwise the task blocks: it is appended to
// the lock's waiter queue and its priority is donated along the holder
// chain. If the new wait edge closes a cycle, a *CycleError describing
// the cycle is returned (the edge is kept; the simulator remains in a
// consistent deadlocked state).
func (s *Simulator) Request(taskID, lockID string) error {
	t, ok := s.tasks[taskID]
	if !ok {
		return fmt.Errorf("unknown task %q", taskID)
	}
	l, ok := s.locks[lockID]
	if !ok {
		return fmt.Errorf("unknown lock %q", lockID)
	}
	if t.waitsOn != nil {
		return fmt.Errorf("task %q is already blocked on lock %q", taskID, t.waitsOn.id)
	}
	if l.holder == t {
		return fmt.Errorf("task %q already holds lock %q", taskID, lockID)
	}
	if l.holder == nil {
		l.holder = t
		return nil
	}
	t.waitsOn = l
	l.waiters = append(l.waiters, t)
	s.recompute()
	if cycle := s.findCycle(t); cycle != nil {
		return &CycleError{Cycle: cycle}
	}
	return nil
}

// Release makes taskID give up lockID. The lock is handed off to the
// first waiter in FIFO order, if any, which unblocks that task. All
// donations that flowed through the released lock are withdrawn and
// effective priorities are recomputed from base priorities.
func (s *Simulator) Release(taskID, lockID string) error {
	t, ok := s.tasks[taskID]
	if !ok {
		return fmt.Errorf("unknown task %q", taskID)
	}
	l, ok := s.locks[lockID]
	if !ok {
		return fmt.Errorf("unknown lock %q", lockID)
	}
	if l.holder != t {
		return fmt.Errorf("task %q does not hold lock %q", taskID, lockID)
	}
	if len(l.waiters) > 0 {
		next := l.waiters[0]
		l.waiters = l.waiters[1:]
		next.waitsOn = nil
		l.holder = next
	} else {
		l.holder = nil
	}
	s.recompute()
	return nil
}

// Effective returns the task's current effective (donated) priority.
func (s *Simulator) Effective(taskID string) (int, bool) {
	t, ok := s.tasks[taskID]
	if !ok {
		return 0, false
	}
	return t.eff, true
}

// Base returns the task's base priority.
func (s *Simulator) Base(taskID string) (int, bool) {
	t, ok := s.tasks[taskID]
	if !ok {
		return 0, false
	}
	return t.base, true
}

// Holder returns the ID of the task currently holding lockID, or "" if
// the lock is free.
func (s *Simulator) Holder(lockID string) (string, bool) {
	l, ok := s.locks[lockID]
	if !ok {
		return "", false
	}
	if l.holder == nil {
		return "", true
	}
	return l.holder.id, true
}

// Waiters returns the IDs of tasks blocked on lockID, in arrival order.
func (s *Simulator) Waiters(lockID string) ([]string, bool) {
	l, ok := s.locks[lockID]
	if !ok {
		return nil, false
	}
	ids := make([]string, len(l.waiters))
	for i, w := range l.waiters {
		ids[i] = w.id
	}
	return ids, true
}

// WaitEdges returns the current wait-for graph as a map from a blocked
// task's ID to the ID of the task holding the lock it waits on.
func (s *Simulator) WaitEdges() map[string]string {
	edges := make(map[string]string)
	for _, t := range s.tasks {
		if t.waitsOn != nil && t.waitsOn.holder != nil {
			edges[t.id] = t.waitsOn.holder.id
		}
	}
	return edges
}

// recompute recomputes every effective priority as the least fixed
// point of the donation equations. Iteration is monotone and bounded by
// the maximum base priority, so it terminates even on wait-for cycles.
func (s *Simulator) recompute() {
	for _, t := range s.tasks {
		t.eff = t.base
	}
	for changed := true; changed; {
		changed = false
		for _, l := range s.locks {
			if l.holder == nil {
				continue
			}
			for _, w := range l.waiters {
				if w.eff > l.holder.eff {
					l.holder.eff = w.eff
					changed = true
				}
			}
		}
	}
}

// findCycle follows the wait-for chain starting at t and returns the
// task IDs forming a cycle, or nil if the chain ends at an unblocked
// task.
func (s *Simulator) findCycle(start *task) []string {
	seen := make(map[*task]int)
	var path []*task
	cur := start
	for {
		if idx, ok := seen[cur]; ok {
			cycle := make([]string, 0, len(path)-idx)
			for _, t := range path[idx:] {
				cycle = append(cycle, t.id)
			}
			return cycle
		}
		seen[cur] = len(path)
		path = append(path, cur)
		if cur.waitsOn == nil || cur.waitsOn.holder == nil {
			return nil
		}
		cur = cur.waitsOn.holder
	}
}
