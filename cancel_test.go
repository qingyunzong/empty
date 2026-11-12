package dataeng

import (
	"sync"
	"testing"
	"time"
)

// 取消未启动任务：永不执行，且不占用任何额度。
func TestCancelPendingNeverRuns(t *testing.T) {
	cb := newCbCtl()
	cfg := Config{MaxConcurrent: 1}
	s, clk := newTestScheduler(t, cfg, cb.callback)
	now := clk.Now()

	cb.register(1)
	cb.registerDone(3)
	mustSubmit(t, s, Task{Source: "A", Seq: 1, Ready: now})
	h2 := mustSubmit(t, s, Task{Source: "A", Seq: 2, Ready: now})
	mustSubmit(t, s, Task{Source: "A", Seq: 3, Ready: now})

	waitFor(t, func() bool { return s.Running() == 1 }, "seq 1 running")
	if err := h2.Cancel(); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	waitFor(t, func() bool { return s.Pending() == 1 }, "cancelled task removed")

	cb.release(1)
	waitFor(t, func() bool { return cb.startedCount() == 2 }, "seq 3 fills slot")
	waitFor(t, func() bool { return s.Running() == 0 && s.Pending() == 0 }, "drain")

	for _, seq := range cb.startOrder() {
		if seq == 2 {
			t.Fatal("cancelled pending task executed")
		}
	}
}

// 取消运行任务：只发取消信号，额度在回调返回前不释放。
func TestCancelRunningSignalsButKeepsQuota(t *testing.T) {
	cb := newCbCtl()
	cfg := Config{MaxConcurrent: 1}
	s, clk := newTestScheduler(t, cfg, cb.callback)
	now := clk.Now()

	cb.register(1)
	cb.registerDone(2)
	h1 := mustSubmit(t, s, Task{Source: "A", Seq: 1, Ready: now})
	mustSubmit(t, s, Task{Source: "A", Seq: 2, Ready: now})

	<-cb.waitStart(1)
	cancelObserved := cb.waitCancel(1)
	if err := h1.Cancel(); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	<-cancelObserved

	// Quota stays occupied until the callback returns.
	assertNot(t, func() bool { return cb.startedCount() == 2 }, "quota held while callback still running")
	if s.Running() != 1 {
		t.Fatalf("running = %d, want 1 until callback returns", s.Running())
	}

	cb.release(1)
	waitFor(t, func() bool { return cb.startedCount() == 2 }, "seq 2 starts after callback ends")
	waitFor(t, func() bool { return s.Running() == 0 }, "drain")
}

// 取消竞争：取消与派发并发进行。被取消的任务要么从未启动，要么收到了取消信号。
func TestCancelDispatchRace(t *testing.T) {
	cb := newCbCtl()
	cfg := Config{MaxConcurrent: 2}
	s, clk := newTestScheduler(t, cfg, cb.callback)
	now := clk.Now()

	const n = 64
	handles := make([]*Handle, 0, n)
	for seq := int64(1); seq <= n; seq++ {
		cb.register(seq)
		h, err := s.Submit(Task{Source: "A", Seq: seq, Ready: now})
		if err != nil {
			t.Fatalf("submit %d: %v", seq, err)
		}
		handles = append(handles, h)
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for _, h := range handles {
			_ = h.Cancel()
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 5; i++ {
			clk.Advance(time.Second)
		}
	}()
	wg.Wait()

	for seq := int64(1); seq <= n; seq++ {
		cb.release(seq)
	}
	waitFor(t, func() bool { return s.Running() == 0 && s.Pending() == 0 }, "all settled")

	cb.mu.Lock()
	defer cb.mu.Unlock()
	for seq := int64(1); seq <= n; seq++ {
		_, ran := cb.started[seq]
		if ran && !cb.canceled[seq] {
			t.Fatalf("task %d ran without observing cancellation", seq)
		}
	}
}
