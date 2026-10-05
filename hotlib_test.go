package hotlib

import (
	"context"
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"sync"
	"testing"
	"time"
)

// blockingTask returns a task function that finishes when release is
// closed or its context is cancelled.
func blockingTask(release <-chan struct{}) func(context.Context) {
	return func(ctx context.Context) {
		select {
		case <-release:
		case <-ctx.Done():
		}
	}
}

func waitClosed(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

func checkNotClosed(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
		t.Fatalf("%s closed unexpectedly", what)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestSwitchKeepsOldGenerationRunning(t *testing.T) {
	lib := New(Config{Name: "v0"})
	release := make(chan struct{})
	old := lib.Start(blockingTask(release))
	if old.Generation() != 0 {
		t.Fatalf("old task bound to gen %d, want 0", old.Generation())
	}

	sealed := lib.Switch(Config{Name: "v1"})
	if sealed != 0 {
		t.Fatalf("Switch sealed gen %d, want 0", sealed)
	}

	// The old task must still be running: a switch never cancels it.
	checkNotClosed(t, old.Done(), "old generation task")

	_, cfg := lib.Current()
	if cfg.Name != "v1" {
		t.Fatalf("current config = %q, want v1", cfg.Name)
	}

	close(release)
	waitClosed(t, old.Done(), "old task completion")
	if old.Err() != nil {
		t.Fatalf("old task Err() = %v, want nil", old.Err())
	}
	lib.WaitOld()
}

func TestNewTasksBindOnlyToNewGeneration(t *testing.T) {
	lib := New(Config{Name: "v0"})
	release := make(chan struct{})
	first := lib.Start(blockingTask(release))
	lib.Switch(Config{Name: "v1"})
	second := lib.Start(blockingTask(release))
	lib.Switch(Config{Name: "v2"})
	third := lib.Start(blockingTask(release))

	if first.Generation() != 0 || second.Generation() != 1 || third.Generation() != 2 {
		t.Fatalf("generations = %d,%d,%d, want 0,1,2",
			first.Generation(), second.Generation(), third.Generation())
	}
	close(release)
	for _, task := range []*Task{first, second, third} {
		waitClosed(t, task.Done(), "task completion")
	}
	lib.WaitOld()
}

func TestCancelTask(t *testing.T) {
	lib := New(Config{Name: "v0"})
	task := lib.Start(blockingTask(make(chan struct{})))
	task.Cancel()
	waitClosed(t, task.Done(), "cancelled task")
	if task.Err() != context.Canceled {
		t.Fatalf("Err() = %v, want context.Canceled", task.Err())
	}
	lib.Switch(Config{Name: "v1"})
	lib.WaitOld()
}

func TestWaitOldIgnoresGenerationCurrentAtCall(t *testing.T) {
	lib := New(Config{Name: "v0"})
	release := make(chan struct{})
	defer close(release)
	lib.Start(blockingTask(release)) // belongs to the current generation

	waited := make(chan struct{})
	go func() {
		lib.WaitOld()
		close(waited)
	}()
	// Nothing is sealed yet, so WaitOld must return even though the
	// current generation still has a live task.
	waitClosed(t, waited, "WaitOld with only current-generation tasks")
}

func TestWaitOldNotExtendedByLaterSwitches(t *testing.T) {
	lib := New(Config{Name: "v0"})
	releaseOld := make(chan struct{})
	old1 := lib.Start(blockingTask(releaseOld))
	old2 := lib.Start(blockingTask(releaseOld))
	lib.Switch(Config{Name: "v1"})

	// Captured synchronously: only the generation sealed so far counts.
	waited := lib.OldBarrier()

	// Keep creating new sealed generations, each with a live task.
	releaseNew := make(chan struct{})
	var later []*Task
	for i := 0; i < 20; i++ {
		later = append(later, lib.Start(blockingTask(releaseNew)))
		lib.Switch(Config{Name: fmt.Sprintf("v%d", i+2)})
	}

	// WaitOld only waits for the generation sealed at call time.
	checkNotClosed(t, waited, "WaitOld")
	close(releaseOld)
	waitClosed(t, old1.Done(), "old task 1")
	waitClosed(t, old2.Done(), "old task 2")
	waitClosed(t, waited, "WaitOld after old generation drained")

	// Later generations are still running and were never waited on.
	for _, task := range later {
		checkNotClosed(t, task.Done(), "later generation task")
	}
	close(releaseNew)
	for _, task := range later {
		waitClosed(t, task.Done(), "later task completion")
	}
	lib.WaitOld()
}

// TestRandomHistory replays randomized start/switch/cancel/release
// histories and checks the live task set of every generation after each
// step. Task completion is fully controlled by the test, so the expected
// per-generation sets are exact.
func TestRandomHistory(t *testing.T) {
	seeds := []int64{1, 7, 42, 2026, 99173}
	for _, seed := range seeds {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			runRandomHistory(t, rand.New(rand.NewSource(seed)), 400)
		})
	}
}

type liveTask struct {
	task    *Task
	release chan struct{}
	gen     uint64
}

func runRandomHistory(t *testing.T, rng *rand.Rand, steps int) {
	t.Helper()
	lib := New(Config{Name: "gen-0"})
	curGen, curCfg := lib.Current()

	live := map[uint64]map[uint64]*liveTask{} // gen -> task ID -> handle
	started := map[uint64]map[uint64]bool{}   // gen -> all task IDs ever started
	var order []*liveTask                     // live tasks in start order

	checkSnapshot := func() {
		t.Helper()
		want := map[uint64][]uint64{}
		for gen, tasks := range live {
			for id := range tasks {
				want[gen] = append(want[gen], id)
			}
		}
		got := lib.Snapshot()
		for gen, ids := range got {
			sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
			if len(ids) == 0 {
				delete(got, gen)
				continue
			}
			got[gen] = ids
		}
		for gen := range want {
			ids := want[gen]
			sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
			want[gen] = ids
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("Snapshot() = %v, want %v", got, want)
		}
	}

	remove := func(idx int) {
		lt := order[idx]
		order = append(order[:idx], order[idx+1:]...)
		delete(live[lt.gen], lt.task.ID())
		if len(live[lt.gen]) == 0 {
			delete(live, lt.gen)
		}
	}

	for step := 0; step < steps; step++ {
		op := rng.Intn(100)
		switch {
		case op < 40 || len(order) == 0: // start
			release := make(chan struct{})
			task := lib.Start(blockingTask(release))
			if task.Generation() != curGen {
				t.Fatalf("step %d: task %d bound to gen %d, current gen is %d",
					step, task.ID(), task.Generation(), curGen)
			}
			lt := &liveTask{task: task, release: release, gen: curGen}
			if live[curGen] == nil {
				live[curGen] = map[uint64]*liveTask{}
			}
			live[curGen][task.ID()] = lt
			if started[curGen] == nil {
				started[curGen] = map[uint64]bool{}
			}
			started[curGen][task.ID()] = true
			order = append(order, lt)

		case op < 60: // switch
			sealed := lib.Switch(Config{Name: fmt.Sprintf("gen-%d", curGen+1), Value: step})
			if sealed != curGen {
				t.Fatalf("step %d: Switch sealed gen %d, want %d", step, sealed, curGen)
			}
			curGen, curCfg = lib.Current()
			if curCfg.Name != fmt.Sprintf("gen-%d", curGen) {
				t.Fatalf("step %d: current config = %+v", step, curCfg)
			}

		case op < 80: // cancel a random live task
			idx := rng.Intn(len(order))
			lt := order[idx]
			lt.task.Cancel()
			waitClosed(t, lt.task.Done(), "cancelled task")
			if lt.task.Err() != context.Canceled {
				t.Fatalf("step %d: Err() = %v, want context.Canceled", step, lt.task.Err())
			}
			remove(idx)

		case op < 90: // release a random live task (normal completion)
			idx := rng.Intn(len(order))
			lt := order[idx]
			close(lt.release)
			waitClosed(t, lt.task.Done(), "released task")
			if lt.task.Err() != nil {
				t.Fatalf("step %d: Err() = %v, want nil", step, lt.task.Err())
			}
			remove(idx)

		default: // WaitOld must drain exactly the generations sealed now
			waited := lib.OldBarrier()
			var sealedLive []*liveTask
			for gen, tasks := range live {
				if gen == curGen {
					continue
				}
				for _, lt := range tasks {
					sealedLive = append(sealedLive, lt)
				}
			}
			if len(sealedLive) > 0 {
				checkNotClosed(t, waited, "WaitOld")
			}
			for _, lt := range sealedLive {
				lt.task.Cancel()
				waitClosed(t, lt.task.Done(), "sealed task drain")
				delete(live[lt.gen], lt.task.ID())
				if len(live[lt.gen]) == 0 {
					delete(live, lt.gen)
				}
				for i, o := range order {
					if o == lt {
						order = append(order[:i], order[i+1:]...)
						break
					}
				}
			}
			// Current-generation tasks are still live, yet WaitOld
			// must return once the sealed generations drained.
			waitClosed(t, waited, "WaitOld")
		}
		checkSnapshot()
	}

	// Drain everything: seal the current generation and cancel the rest.
	lib.Switch(Config{Name: "final"})
	for _, lt := range order {
		lt.task.Cancel()
		waitClosed(t, lt.task.Done(), "final drain")
	}
	lib.WaitOld()
	for gen, ids := range lib.Snapshot() {
		if len(ids) != 0 {
			t.Fatalf("generation %d still has live tasks %v after drain", gen, ids)
		}
	}
	t.Logf("history: %d steps, %d generations, %d tasks started",
		steps, len(started), totalStarted(started))
}

func totalStarted(m map[uint64]map[uint64]bool) int {
	n := 0
	for _, tasks := range m {
		n += len(tasks)
	}
	return n
}

// TestConcurrentSmoke hammers the library from many goroutines so the
// race detector can catch unsynchronized generation handoffs.
func TestConcurrentSmoke(t *testing.T) {
	lib := New(Config{Name: "v0"})

	var wg sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func(rng *rand.Rand) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				switch rng.Intn(10) {
				case 0:
					lib.Switch(Config{Name: "hot", Value: rng.Int()})
				case 1:
					lib.WaitOld()
				default:
					delay := time.Duration(rng.Intn(200)) * time.Microsecond
					task := lib.Start(func(ctx context.Context) {
						select {
						case <-time.After(delay):
						case <-ctx.Done():
						}
					})
					if rng.Intn(3) == 0 {
						task.Cancel()
					}
				}
			}
		}(rand.New(rand.NewSource(int64(worker))))
	}
	wg.Wait()
	lib.Switch(Config{Name: "final"})
	lib.WaitOld()

	deadline := time.Now().Add(2 * time.Second)
	for {
		empty := true
		for _, ids := range lib.Snapshot() {
			if len(ids) != 0 {
				empty = false
			}
		}
		if empty {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("generations did not drain: %v", lib.Snapshot())
		}
		time.Sleep(time.Millisecond)
	}
}
