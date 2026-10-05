package modlib

import (
	"fmt"
	"math/rand"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestOldGenTasksFinishAfterSwitch(t *testing.T) {
	l := New(Config{Name: "v1"})
	old1 := l.Start()
	old2 := l.Start()

	l.Switch(Config{Name: "v2"})

	// Old-generation tasks keep running and finish normally after the switch.
	old1.Finish()
	old2.Cancel()

	snap := l.Snapshot()
	if len(snap) != 2 {
		t.Fatalf("want 2 generations, got %d", len(snap))
	}
	if snap[0][old1.ID()] != Finished || snap[0][old2.ID()] != Cancelled {
		t.Fatalf("old gen states = %v", snap[0])
	}
}

func TestNewTasksBindOnlyToNewGen(t *testing.T) {
	l := New(Config{Name: "v1"})
	t0 := l.Start()
	gen := l.Switch(Config{Name: "v2"})
	t1 := l.Start()
	gen = l.Switch(Config{Name: "v3"})
	t2 := l.Start()

	if t0.Gen() != 0 || t1.Gen() != 1 || t2.Gen() != 2 {
		t.Fatalf("binding: got gens %d,%d,%d", t0.Gen(), t1.Gen(), t2.Gen())
	}
	if cur, cfg := l.Current(); cur != 2 || cfg.Name != "v3" {
		t.Fatalf("current = (%d,%v)", cur, cfg)
	}
	_ = gen
	snap := l.Snapshot()
	for g, want := range []map[uint64]State{
		{t0.ID(): Active},
		{t1.ID(): Active},
		{t2.ID(): Active},
	} {
		if !reflect.DeepEqual(snap[g], want) {
			t.Fatalf("gen %d = %v, want %v", g, snap[g], want)
		}
	}
}

func TestWaitOldSealedAtCallTime(t *testing.T) {
	l := New(Config{Name: "g0"})
	t0 := l.Start()
	l.Switch(Config{Name: "g1"})
	t1 := l.Start()

	snapshotted := make(chan struct{})
	l.waitOldSnapshotHook = func() { close(snapshotted) }

	done := make(chan struct{})
	go func() {
		l.WaitOld() // current gen is 1: must wait only for gen 0
		close(done)
	}()
	<-snapshotted // WaitOld has sealed its view: only gen 0
	l.waitOldSnapshotHook = nil

	// A later switch seals gen 1, but the pending WaitOld must not be
	// extended by it.
	l.Switch(Config{Name: "g2"})
	t2 := l.Start()

	t0.Finish() // drains gen 0
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("WaitOld did not return after gen 0 drained; it was extended by a later generation")
	}

	// t1 (now old) and t2 (current) are still active; clean up.
	t1.Cancel()
	t2.Finish()
	l.WaitOld()
}

func TestWaitOldIgnoresCurrentGeneration(t *testing.T) {
	l := New(Config{Name: "g0"})
	t0 := l.Start()
	l.Switch(Config{Name: "g1"})
	current := l.Start() // belongs to the open generation

	done := make(chan struct{})
	go func() { l.WaitOld(); close(done) }()

	t0.Finish()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("WaitOld blocked on the still-open current generation")
	}
	current.Finish()
}

func TestFinishCancelIdempotent(t *testing.T) {
	l := New(Config{Name: "g0"})
	task := l.Start()
	task.Cancel()
	task.Cancel()
	task.Finish() // no-op after cancel
	if got := l.Snapshot()[0][task.ID()]; got != Cancelled {
		t.Fatalf("state = %v, want cancelled", got)
	}
	l.Switch(Config{Name: "g1"})
	l.WaitOld() // must return: gen 0 is drained
}

// TestRandomHistoryAgainstModel performs random starts, switches, finishes
// and cancels, then checks the library's per-generation task sets against
// an independently maintained history model.
func TestRandomHistoryAgainstModel(t *testing.T) {
	seeds := []int64{1, 7, 42, 20261005, 987654321}
	for _, seed := range seeds {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			runRandomHistory(t, seed, 3000)
		})
	}
}

func runRandomHistory(t *testing.T, seed int64, steps int) {
	t.Helper()
	rng := rand.New(rand.NewSource(seed))
	l := New(Config{Name: "g0", Version: 0})

	// model[g][taskID] mirrors the expected history of every generation.
	model := []map[uint64]State{{}}
	tasks := map[uint64]*Task{}
	var active []uint64

	removeActive := func(id uint64) {
		for i, a := range active {
			if a == id {
				active = append(active[:i], active[i+1:]...)
				return
			}
		}
		t.Fatalf("task %d not active", id)
	}

	check := func(step int) {
		t.Helper()
		snap := l.Snapshot()
		if len(snap) != len(model) {
			t.Fatalf("step %d: %d generations, want %d", step, len(snap), len(model))
		}
		for g := range model {
			if !reflect.DeepEqual(snap[g], model[g]) {
				t.Fatalf("step %d: gen %d = %v, want %v", step, g, snap[g], model[g])
			}
		}
	}

	for step := 0; step < steps; step++ {
		switch op := rng.Intn(10); {
		case op < 4 || len(active) == 0: // start
			task := l.Start()
			g := len(model) - 1
			model[g][task.ID()] = Active
			tasks[task.ID()] = task
			active = append(active, task.ID())
			if task.Gen() != uint64(g) {
				t.Fatalf("step %d: task bound to gen %d, want %d", step, task.Gen(), g)
			}
		case op < 6: // switch
			v := len(model)
			newGen := l.Switch(Config{Name: fmt.Sprintf("g%d", v), Version: v})
			if newGen != uint64(v) {
				t.Fatalf("step %d: switch returned gen %d, want %d", step, newGen, v)
			}
			model = append(model, map[uint64]State{})
		case op < 8: // finish a random active task
			id := active[rng.Intn(len(active))]
			tasks[id].Finish()
			model[tasks[id].Gen()][id] = Finished
			removeActive(id)
		default: // cancel a random active task
			id := active[rng.Intn(len(active))]
			tasks[id].Cancel()
			model[tasks[id].Gen()][id] = Cancelled
			removeActive(id)
		}
		if step%97 == 0 {
			check(step)
		}
	}
	check(steps)

	// Drain everything; WaitOld over all sealed generations must return.
	for _, id := range active {
		tasks[id].Finish()
		model[tasks[id].Gen()][id] = Finished
	}
	l.Switch(Config{Name: "final"})
	model = append(model, map[uint64]State{})
	l.WaitOld()
	check(steps + 1)
}

// TestConcurrentRandomOps hammers the library from many goroutines to
// exercise the locking under -race, then verifies the drained state.
func TestConcurrentRandomOps(t *testing.T) {
	l := New(Config{Name: "g0"})
	const workers = 8
	const opsPerWorker = 500

	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(seed int64) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(seed))
			var mine []*Task
			for i := 0; i < opsPerWorker; i++ {
				switch rng.Intn(4) {
				case 0:
					mine = append(mine, l.Start())
				case 1:
					l.Switch(Config{Name: "hot", Version: i})
				case 2:
					if len(mine) > 0 {
						t := mine[len(mine)-1]
						mine = mine[:len(mine)-1]
						t.Finish()
					}
				case 3:
					if len(mine) > 0 {
						t := mine[len(mine)-1]
						mine = mine[:len(mine)-1]
						t.Cancel()
					}
				}
			}
			for _, t := range mine {
				t.Finish()
			}
		}(int64(w)*7919 + 13)
	}
	wg.Wait()

	// Seal the last generation; everything ever started must drain.
	l.Switch(Config{Name: "final"})
	waitDone := make(chan struct{})
	go func() { l.WaitOld(); close(waitDone) }()
	select {
	case <-waitDone:
	case <-time.After(10 * time.Second):
		t.Fatal("WaitOld did not return after all tasks completed")
	}

	snap := l.Snapshot()
	for g, tasks := range snap[:len(snap)-1] {
		for id, st := range tasks {
			if st == Active {
				t.Fatalf("gen %d task %d still active after drain", g, id)
			}
		}
	}
}
