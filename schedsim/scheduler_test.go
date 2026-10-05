package schedsim

import "testing"

// Local takes are LIFO (tail), steals are FIFO (head).
func TestDequeEnds(t *testing.T) {
	s := NewScheduler(2)
	s.Submit(0) // 0
	s.Submit(0) // 1
	s.Submit(0) // 2

	if id, ok := s.LocalTake(0); !ok || id != 2 {
		t.Fatalf("local take = %d,%v; want tail task 2", id, ok)
	}
	if id, ok := s.Steal(0, 1); !ok || id != 0 {
		t.Fatalf("steal = %d,%v; want head task 0", id, ok)
	}
	if id, ok := s.LocalTake(0); !ok || id != 1 {
		t.Fatalf("local take = %d,%v; want task 1", id, ok)
	}
	if _, ok := s.Steal(0, 1); ok {
		t.Fatal("steal from empty queue succeeded")
	}
	if s.Executed() != 3 {
		t.Fatalf("executed = %d; want 3", s.Executed())
	}
}

// Two takes competing for the same single task: exactly one succeeds.
func TestContendedTakeOnlyOneWins(t *testing.T) {
	s := NewScheduler(3)
	s.Submit(1)

	if _, ok := s.LocalTake(1); !ok {
		t.Fatal("first take failed")
	}
	if _, ok := s.Steal(1, 0); ok {
		t.Fatal("second competing take also succeeded")
	}
	if _, ok := s.Steal(1, 2); ok {
		t.Fatal("third competing take also succeeded")
	}
	if s.Executed() != 1 {
		t.Fatalf("executed = %d; want exactly 1", s.Executed())
	}
	if err := s.CheckInvariants(); err != nil {
		t.Fatal(err)
	}
}

// Cancellation takes effect only while the task is still queued.
func TestCancelOnlyBeforeExecution(t *testing.T) {
	s := NewScheduler(2)
	queued := s.Submit(0)
	ran := s.Submit(0)
	if _, ok := s.LocalTake(0); !ok {
		t.Fatal("take failed")
	}

	if !s.Cancel(queued) {
		t.Fatal("cancel of queued task did not take effect")
	}
	if s.Cancel(ran) {
		t.Fatal("cancel of executed task took effect")
	}
	if s.Cancel(queued) {
		t.Fatal("double cancel took effect")
	}
	if s.Cancel(999) {
		t.Fatal("cancel of unknown task took effect")
	}
	if s.Executed() != 1 || s.Cancelled() != 1 || s.Queued() != 0 {
		t.Fatalf("executed=%d cancelled=%d queued=%d; want 1/1/0",
			s.Executed(), s.Cancelled(), s.Queued())
	}
	if err := s.CheckInvariants(); err != nil {
		t.Fatal(err)
	}
}

// Event stepping is deterministic: identical histories give identical states.
func TestEventSteppingDeterministic(t *testing.T) {
	history := []Event{
		{Kind: EvSubmit, Queue: 0},
		{Kind: EvSubmit, Queue: 0},
		{Kind: EvSubmit, Queue: 1},
		{Kind: EvSteal, From: 0, To: 2},
		{Kind: EvCancel, TaskID: 2},
		{Kind: EvLocalTake, Queue: 1},
		{Kind: EvSteal, From: 0, To: 1},
		{Kind: EvLocalTake, Queue: 0},
	}
	a := NewScheduler(3)
	b := NewScheduler(3)
	a.Run(history)
	b.Run(history)
	if a.Key() != b.Key() {
		t.Fatalf("same history diverged:\n a=%q\n b=%q", a.Key(), b.Key())
	}
	if a.Executed() != 2 || a.Cancelled() != 1 {
		t.Fatalf("executed=%d cancelled=%d; want 2/1", a.Executed(), a.Cancelled())
	}
}

// applicableEvents enumerates every event that makes sense in state s.
func applicableEvents(s *Scheduler, numQueues, maxTasks int) []Event {
	var evs []Event
	if s.Submitted() < maxTasks {
		for q := 0; q < numQueues; q++ {
			evs = append(evs, Event{Kind: EvSubmit, Queue: q})
		}
	}
	for from := 0; from < numQueues; from++ {
		if s.QueueLen(from) == 0 {
			continue
		}
		evs = append(evs, Event{Kind: EvLocalTake, Queue: from})
		for to := 0; to < numQueues; to++ {
			if to != from {
				evs = append(evs, Event{Kind: EvSteal, From: from, To: to})
			}
		}
	}
	for id := 0; id < s.Submitted(); id++ {
		evs = append(evs, Event{Kind: EvCancel, TaskID: id})
	}
	return evs
}

// Exhaustively enumerate event histories over three queues and check, at
// every step of every history, that (a) invariants hold, (b) no task ever
// executes twice, and (c) queue conservation holds:
// executed + cancelled + queued == submitted.
func TestEnumerateThreeQueueHistories(t *testing.T) {
	const (
		numQueues = 3
		maxTasks  = 3
		maxDepth  = 12
	)
	visited := map[string]bool{NewScheduler(numQueues).Key(): true}
	steps := 0

	var dfs func(s *Scheduler, depth int)
	dfs = func(s *Scheduler, depth int) {
		if err := s.CheckInvariants(); err != nil {
			t.Fatalf("invariant violated at depth %d: %v", depth, err)
		}
		if s.Executed() > s.Submitted() {
			t.Fatalf("executed %d > submitted %d", s.Executed(), s.Submitted())
		}
		if depth == maxDepth {
			return
		}
		for _, ev := range applicableEvents(s, numQueues, maxTasks) {
			ns := s.Clone()
			ns.Apply(ev)
			steps++
			if err := ns.CheckInvariants(); err != nil {
				t.Fatalf("invariant violated after %+v: %v", ev, err)
			}
			key := ns.Key()
			if visited[key] {
				continue
			}
			visited[key] = true
			dfs(ns, depth+1)
		}
	}
	dfs(NewScheduler(numQueues), 0)

	if len(visited) < 100 {
		t.Fatalf("only %d distinct states explored; enumeration too shallow", len(visited))
	}
	t.Logf("queues=%d maxTasks=%d maxDepth=%d: %d distinct states, %d event applications checked",
		numQueues, maxTasks, maxDepth, len(visited), steps)
}
