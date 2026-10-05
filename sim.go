// Package prioritysim implements a discrete-time thread simulator with
// mutexes, transitive priority inheritance and deadlock cycle reporting.
package prioritysim

import "fmt"

type Op int

const (
	OpLock Op = iota
	OpUnlock
	OpWork
)

// Inst is a single program instruction for a thread.
type Inst struct {
	Op    Op
	Mutex int // mutex id for OpLock / OpUnlock
	Ticks int // duration for OpWork
}

func Lock(m int) Inst   { return Inst{Op: OpLock, Mutex: m} }
func Unlock(m int) Inst { return Inst{Op: OpUnlock, Mutex: m} }
func Work(n int) Inst   { return Inst{Op: OpWork, Ticks: n} }

type Thread struct {
	ID        int
	Base      int // base priority, higher wins
	Start     int // arrival tick
	Eff       int // effective priority (base + inherited)
	prog      []Inst
	pc        int
	workLeft  int
	waitingOn int // mutex id the thread is blocked on, -1 if runnable
	done      bool
}

type Mutex struct {
	ID      int
	Owner   int // thread id, -1 if free
	waiters map[int]bool
}

type Sim struct {
	threads  []*Thread
	mutexes  []*Mutex
	Tick     int
	Choice   []int    // thread id chosen at each tick
	Deadlock []int    // thread ids forming the wait-for cycle, nil if none
	Log      []string // human readable event log
}

func New(numMutexes int) *Sim {
	s := &Sim{}
	for i := 0; i < numMutexes; i++ {
		s.mutexes = append(s.mutexes, &Mutex{ID: i, Owner: -1, waiters: map[int]bool{}})
	}
	return s
}

func (s *Sim) AddThread(id, base, start int, prog ...Inst) {
	s.threads = append(s.threads, &Thread{
		ID: id, Base: base, Start: start, Eff: base,
		prog: prog, waitingOn: -1,
	})
}

func (s *Sim) thread(id int) *Thread {
	for _, t := range s.threads {
		if t.ID == id {
			return t
		}
	}
	return nil
}

func (s *Sim) logf(format string, args ...any) {
	s.Log = append(s.Log, fmt.Sprintf(format, args...))
}

// recomputeAll recomputes every effective priority from scratch by walking
// the full wait-for graph: each blocked thread propagates its base priority
// to every thread it (transitively) waits on.
func (s *Sim) recomputeAll() {
	for _, t := range s.threads {
		t.Eff = t.Base
	}
	for _, t := range s.threads {
		visited := map[int]bool{t.ID: true}
		cur := t
		for cur.waitingOn >= 0 {
			owner := s.mutexes[cur.waitingOn].Owner
			if owner < 0 || visited[owner] {
				break
			}
			visited[owner] = true
			if o := s.thread(owner); o.Eff < t.Base {
				o.Eff = t.Base
			}
			cur = s.thread(owner)
		}
	}
}

// findCycle walks the wait-for chain starting at start and returns the
// cycle of thread ids if the chain loops back on itself.
func (s *Sim) findCycle(start int) []int {
	seen := map[int]int{}
	path := []int{}
	cur := start
	for {
		if idx, ok := seen[cur]; ok {
			return append([]int{}, path[idx:]...)
		}
		seen[cur] = len(path)
		path = append(path, cur)
		t := s.thread(cur)
		if t.waitingOn < 0 {
			return nil
		}
		owner := s.mutexes[t.waitingOn].Owner
		if owner < 0 {
			return nil
		}
		cur = owner
	}
}

func (s *Sim) allDone() bool {
	for _, t := range s.threads {
		if !t.done {
			return false
		}
	}
	return true
}

// pick selects the runnable thread with the highest effective priority,
// breaking ties by smaller thread id.
func (s *Sim) pick() *Thread {
	var best *Thread
	for _, t := range s.threads {
		if t.done || t.waitingOn >= 0 || s.Tick < t.Start {
			continue
		}
		if best == nil || t.Eff > best.Eff || (t.Eff == best.Eff && t.ID < best.ID) {
			best = t
		}
	}
	return best
}

// Step advances the simulation by one tick. It returns false when the
// simulation is over: all threads done, a deadlock was reported, or no
// thread is runnable.
func (s *Sim) Step() bool {
	if s.Deadlock != nil || s.allDone() {
		return false
	}
	t := s.pick()
	if t == nil {
		s.logf("tick %d: no runnable thread", s.Tick)
		return false
	}
	s.Choice = append(s.Choice, t.ID)
	s.exec(t)
	s.Tick++
	return true
}

// Run steps the simulation until it ends or maxTicks is reached.
func (s *Sim) Run(maxTicks int) {
	for s.Tick < maxTicks && s.Step() {
	}
}

func (s *Sim) exec(t *Thread) {
	if t.workLeft > 0 {
		t.workLeft--
		s.logf("tick %d: T%d works (eff=%d, left=%d)", s.Tick, t.ID, t.Eff, t.workLeft)
		s.finish(t)
		return
	}
	inst := t.prog[t.pc]
	switch inst.Op {
	case OpWork:
		t.pc++
		t.workLeft = inst.Ticks - 1
		s.logf("tick %d: T%d works (eff=%d, left=%d)", s.Tick, t.ID, t.Eff, t.workLeft)
	case OpLock:
		m := s.mutexes[inst.Mutex]
		switch {
		case m.Owner == t.ID:
			s.Deadlock = []int{t.ID}
			s.logf("tick %d: T%d re-locks M%d: self deadlock", s.Tick, t.ID, m.ID)
		case m.Owner < 0:
			m.Owner = t.ID
			t.pc++
			s.logf("tick %d: T%d locks M%d", s.Tick, t.ID, m.ID)
		default:
			t.waitingOn = m.ID
			m.waiters[t.ID] = true
			s.logf("tick %d: T%d blocks on M%d held by T%d", s.Tick, t.ID, m.ID, m.Owner)
			if cycle := s.findCycle(t.ID); cycle != nil {
				s.Deadlock = cycle
				s.logf("tick %d: deadlock, cycle %v", s.Tick, cycle)
			}
			s.recomputeAll()
		}
	case OpUnlock:
		m := s.mutexes[inst.Mutex]
		if m.Owner != t.ID {
			panic(fmt.Sprintf("T%d unlocks M%d owned by T%d", t.ID, m.ID, m.Owner))
		}
		m.Owner = -1
		t.pc++
		for id := range m.waiters {
			s.thread(id).waitingOn = -1
			delete(m.waiters, id)
		}
		s.logf("tick %d: T%d unlocks M%d", s.Tick, t.ID, m.ID)
		s.recomputeAll()
	}
	s.finish(t)
}

func (s *Sim) finish(t *Thread) {
	if t.pc >= len(t.prog) && t.workLeft == 0 && t.waitingOn < 0 {
		t.done = true
	}
}
