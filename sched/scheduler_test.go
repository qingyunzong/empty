package sched

import (
	"fmt"
	"sync"
	"testing"
)

// mustSubmit submits tasks and fails on error.
func mustSubmit(t *testing.T, s *Scheduler, worker int, ids ...int) {
	t.Helper()
	for _, id := range ids {
		if err := s.Submit(worker, id); err != nil {
			t.Fatalf("submit task %d: %v", id, err)
		}
	}
}

func checkConservation(t *testing.T, s *Scheduler, ctx string) {
	t.Helper()
	if err := s.CheckConservation(); err != nil {
		t.Fatalf("conservation violated after %s: %v", ctx, err)
	}
}

// TestEnds verifies local pops take the tail and steals take the head.
func TestEnds(t *testing.T) {
	s := New(2)
	mustSubmit(t, s, 0, 1, 2, 3) // head [1 2 3] tail

	if id, ok := s.PopLocal(0); !ok || id != 3 {
		t.Fatalf("local pop = %d,%v; want tail 3,true", id, ok)
	}
	if id, ok := s.Steal(1, 0); !ok || id != 1 {
		t.Fatalf("steal = %d,%v; want head 1,true", id, ok)
	}
	if id, ok := s.PopLocal(0); !ok || id != 2 {
		t.Fatalf("local pop = %d,%v; want 2,true", id, ok)
	}
	if _, ok := s.PopLocal(0); ok {
		t.Fatal("pop on empty deque should fail")
	}
	if _, ok := s.Steal(1, 0); ok {
		t.Fatal("steal from empty deque should fail")
	}
	checkConservation(t, s, "ends test")
}

// TestCancelOnlyBeforeExecution verifies cancellation semantics.
func TestCancelOnlyBeforeExecution(t *testing.T) {
	s := New(2)
	mustSubmit(t, s, 0, 1, 2)

	if !s.Cancel(1) {
		t.Fatal("cancel of queued task should succeed")
	}
	if s.Cancel(1) {
		t.Fatal("double cancel should fail")
	}
	if id, ok := s.PopLocal(0); !ok || id != 2 {
		t.Fatalf("pop = %d,%v; want 2,true (task 1 gone)", id, ok)
	}
	if s.Cancel(2) {
		t.Fatal("cancel of executed task must be a no-op")
	}
	if st, _ := s.State(2); st != Executed {
		t.Fatalf("task 2 state = %s; want executed", st)
	}
	if s.Cancel(999) {
		t.Fatal("cancel of unknown task should fail")
	}
	q, e, c := s.Counts()
	if q != 0 || e != 1 || c != 1 {
		t.Fatalf("counts = %d/%d/%d; want 0/1/1", q, e, c)
	}
	checkConservation(t, s, "cancel semantics")
}

// TestContentionSingleWinner runs two take events in one step against a
// deque holding a single task: exactly one may succeed.
func TestContentionSingleWinner(t *testing.T) {
	for _, evs := range [][]Event{
		{{Kind: EvPopLocal, Worker: 0}, {Kind: EvSteal, Worker: 1, Victim: 0}},
		{{Kind: EvSteal, Worker: 1, Victim: 0}, {Kind: EvSteal, Worker: 2, Victim: 0}},
		{{Kind: EvPopLocal, Worker: 0}, {Kind: EvPopLocal, Worker: 0}},
	} {
		s := New(3)
		mustSubmit(t, s, 0, 42)
		res := s.StepAll(evs)
		wins := 0
		for _, r := range res {
			if r.Success {
				wins++
				if r.Took != 42 {
					t.Fatalf("%v: winner took task %d; want 42", evs, r.Took)
				}
			}
		}
		if wins != 1 {
			t.Fatalf("%v: %d winners; want exactly 1", evs, wins)
		}
		if got := len(s.Executed()); got != 1 {
			t.Fatalf("%v: %d executions; want 1", evs, got)
		}
		checkConservation(t, s, fmt.Sprintf("contention %v", evs))
	}
}

// TestConcurrentTakesAtomic hammers one deque from many goroutines;
// the number of successful takes must equal the number of tasks.
func TestConcurrentTakesAtomic(t *testing.T) {
	const tasks = 2000
	s := New(2)
	for i := 0; i < tasks; i++ {
		mustSubmit(t, s, 0, i)
	}
	var wg sync.WaitGroup
	wins := make(chan int, tasks)
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for {
				var id int
				var ok bool
				if g%2 == 0 {
					id, ok = s.PopLocal(0)
				} else {
					id, ok = s.Steal(1, 0)
				}
				if !ok {
					return
				}
				wins <- id
			}
		}(g)
	}
	wg.Wait()
	close(wins)
	seen := make(map[int]bool)
	n := 0
	for id := range wins {
		if seen[id] {
			t.Fatalf("task %d taken twice", id)
		}
		seen[id] = true
		n++
	}
	if n != tasks {
		t.Fatalf("%d successful takes; want %d", n, tasks)
	}
	if got := len(s.Executed()); got != tasks {
		t.Fatalf("executed %d; want %d", got, tasks)
	}
	checkConservation(t, s, "concurrent takes")
}

// TestDeterministicHistory replays a fixed script and checks exact
// execution counts and final queue contents.
func TestDeterministicHistory(t *testing.T) {
	s := New(3)
	script := []Event{
		{Kind: EvSubmit, Worker: 0, Task: 1},
		{Kind: EvSubmit, Worker: 0, Task: 2},
		{Kind: EvSubmit, Worker: 0, Task: 3},
		{Kind: EvSubmit, Worker: 1, Task: 4},
		{Kind: EvSubmit, Worker: 2, Task: 5},
		{Kind: EvSteal, Worker: 1, Victim: 0}, // takes head: 1
		{Kind: EvPopLocal, Worker: 0},         // takes tail: 3
		{Kind: EvCancel, Task: 2},             // queued -> cancelled
		{Kind: EvCancel, Task: 1},             // executed -> no-op
		{Kind: EvSteal, Worker: 2, Victim: 1}, // takes head: 4
		{Kind: EvPopLocal, Worker: 2},         // takes tail: 5
		{Kind: EvPopLocal, Worker: 0},         // empty -> fail
	}
	wantOK := []bool{true, true, true, true, true, true, true, true, false, true, true, false}
	res := s.StepAll(script)
	for i, r := range res {
		if r.Success != wantOK[i] {
			t.Fatalf("step %d (%v): success=%v; want %v", i, script[i], r.Success, wantOK[i])
		}
		checkConservation(t, s, fmt.Sprintf("script step %d", i))
	}
	wantExec := []int{1, 3, 4, 5}
	got := s.Executed()
	if fmt.Sprint(got) != fmt.Sprint(wantExec) {
		t.Fatalf("executed = %v; want %v", got, wantExec)
	}
	q, e, c := s.Counts()
	if q != 0 || e != 4 || c != 1 {
		t.Fatalf("counts = %d/%d/%d; want 0/4/1", q, e, c)
	}
}

// TestEnumerateThreeQueueHistories explores the reachable state space of
// a three-worker scheduler by enumerating event histories (BFS with
// state dedup). Conservation is checked at every reachable state, and
// execution counts are checked at every terminal state.
func TestEnumerateThreeQueueHistories(t *testing.T) {
	const workers = 3
	initial := map[int][]int{ // worker -> tasks (push order)
		0: {1, 2},
		1: {3, 4},
		2: {5},
	}
	totalTasks := 0
	for _, ids := range initial {
		totalTasks += len(ids)
	}

	start := New(workers)
	for w, ids := range initial {
		for _, id := range ids {
			if err := start.Submit(w, id); err != nil {
				t.Fatal(err)
			}
		}
	}

	// ops enumerates every event applicable from the current state.
	ops := func(s *Scheduler) []Event {
		var out []Event
		for w := 0; w < workers; w++ {
			out = append(out, Event{Kind: EvPopLocal, Worker: w})
			for v := 0; v < workers; v++ {
				if v != w {
					out = append(out, Event{Kind: EvSteal, Worker: w, Victim: v})
				}
			}
		}
		for id := 1; id <= totalTasks; id++ {
			out = append(out, Event{Kind: EvCancel, Task: id})
		}
		return out
	}

	type node struct {
		sched *Scheduler
		depth int
	}
	visited := map[string]bool{start.fingerprint(): true}
	queue := []node{{sched: start}}
	states, terminal := 0, 0
	const maxStates = 500000

	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		states++
		if states > maxStates {
			t.Fatalf("state space exceeded %d states; enumeration incomplete", maxStates)
		}
		if err := cur.sched.CheckConservation(); err != nil {
			t.Fatalf("conservation violated at depth %d: %v", cur.depth, err)
		}

		progressed := false
		for _, ev := range ops(cur.sched) {
			next := clone(cur.sched)
			r := next.Step(ev)
			if !r.Success {
				continue // no-op event, not a new history
			}
			progressed = true
			fp := next.fingerprint()
			if visited[fp] {
				continue
			}
			visited[fp] = true
			queue = append(queue, node{sched: next, depth: cur.depth + 1})
		}
		if !progressed {
			// Terminal state: no event changes anything. Every task
			// must be executed or cancelled, and the counts must add up.
			terminal++
			q, e, c := cur.sched.Counts()
			if q != 0 {
				t.Fatalf("terminal state with %d queued tasks", q)
			}
			if e+c != totalTasks {
				t.Fatalf("terminal counts e=%d c=%d; want sum %d", e, c, totalTasks)
			}
			if len(cur.sched.Executed()) != e {
				t.Fatalf("execution log %d != executed count %d", len(cur.sched.Executed()), e)
			}
		}
	}
	t.Logf("explored %d states (%d terminal) over %d workers and %d tasks",
		states, terminal, workers, totalTasks)
	if terminal == 0 {
		t.Fatal("no terminal state reached; enumeration broken")
	}
}

// TestExecutionCountInvariant checks, over random-ish but deterministic
// histories, that successful takes == executed tasks and that
// executed + cancelled + queued always equals the number submitted.
func TestExecutionCountInvariant(t *testing.T) {
	const workers = 3
	for seed := int64(0); seed < 50; seed++ {
		rng := seed
		next := func(n int) int { // simple LCG, deterministic
			rng = (rng*6364136223846793005 + 1442695040888963407) >> 16
			if rng < 0 {
				rng = -rng
			}
			return int(rng % int64(n))
		}
		s := New(workers)
		const tasks = 12
		for i := 0; i < tasks; i++ {
			mustSubmit(t, s, next(workers), i)
		}
		takes := 0
		for step := 0; step < 40; step++ {
			var ev Event
			switch next(3) {
			case 0:
				ev = Event{Kind: EvPopLocal, Worker: next(workers)}
			case 1:
				ev = Event{Kind: EvSteal, Worker: next(workers), Victim: next(workers)}
			case 2:
				ev = Event{Kind: EvCancel, Task: next(tasks)}
			}
			if r := s.Step(ev); r.Success && ev.Kind != EvCancel {
				takes++
			}
			if err := s.CheckConservation(); err != nil {
				t.Fatalf("seed %d step %d: %v", seed, step, err)
			}
			q, e, c := s.Counts()
			if q+e+c != tasks {
				t.Fatalf("seed %d step %d: counts %d+%d+%d != %d", seed, step, q, e, c, tasks)
			}
			if e != takes {
				t.Fatalf("seed %d step %d: executed %d != successful takes %d", seed, step, e, takes)
			}
		}
	}
}

// clone deep-copies a scheduler for state-space exploration.
func clone(s *Scheduler) *Scheduler {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := &Scheduler{
		deques:  make([]deque, len(s.deques)),
		tasks:   make(map[int]*taskRec, len(s.tasks)),
		execLog: append([]int(nil), s.execLog...),
	}
	for w := range s.deques {
		out.deques[w].items = append([]int(nil), s.deques[w].items...)
	}
	for id, rec := range s.tasks {
		cp := *rec
		out.tasks[id] = &cp
	}
	return out
}
