package dataeng

import (
	"testing"
	"time"
)

// 同时到期按提交序号平局裁决；不同到期时间按最早到期优先。
func TestDispatchEarliestReadyThenSeq(t *testing.T) {
	cb := newCbCtl()
	cfg := Config{MaxConcurrent: 1}
	s, clk := newTestScheduler(t, cfg, cb.callback)

	t0 := clk.Now()
	const n = 5
	rels := make(map[int64]chan struct{}, n)
	// seq 1/2/3 share a ready time (tie -> seq order); seq 4 is earlier,
	// seq 5 is later.
	tasks := []Task{
		{Source: "A", Seq: 3, Ready: t0.Add(time.Second)},
		{Source: "A", Seq: 1, Ready: t0.Add(time.Second)},
		{Source: "A", Seq: 2, Ready: t0.Add(time.Second)},
		{Source: "A", Seq: 4, Ready: t0.Add(500 * time.Millisecond)},
		{Source: "A", Seq: 5, Ready: t0.Add(2 * time.Second)},
	}
	for _, task := range tasks {
		rels[task.Seq] = cb.register(task.Seq)
		mustSubmit(t, s, task)
	}

	clk.Advance(2 * time.Second)

	want := []int64{4, 1, 2, 3, 5}
	for i, seq := range want {
		waitFor(t, func() bool { return cb.startedCount() == i+1 }, "task starts")
		if got := cb.startOrder(); got[i] != seq {
			t.Fatalf("start #%d = %v, want %v (full order %v)", i+1, got[i], seq, got)
		}
		close(rels[seq])
	}
	waitFor(t, func() bool { return s.Running() == 0 && s.Pending() == 0 }, "queue drains")
}

// 全局并发上限限制总在跑任务数，完成后自动补位。
func TestGlobalConcurrencyLimit(t *testing.T) {
	cb := newCbCtl()
	cfg := Config{MaxConcurrent: 2} // unlimited sources
	s, clk := newTestScheduler(t, cfg, cb.callback)
	now := clk.Now()

	for _, seq := range []int64{1, 2, 3} {
		cb.register(seq)
		mustSubmit(t, s, Task{Source: "A", Seq: seq, Ready: now})
	}
	waitFor(t, func() bool { return s.Running() == 2 }, "two running")
	assertNot(t, func() bool { return s.Running() == 3 }, "third task stays pending")
	if s.Pending() != 1 {
		t.Fatalf("pending = %d, want 1", s.Pending())
	}

	cb.release(1)
	waitFor(t, func() bool { return s.Running() == 2 && cb.startedCount() == 3 }, "third task fills freed slot")
	cb.release(2)
	cb.release(3)
	waitFor(t, func() bool { return s.Running() == 0 }, "all finish")
}

// 每来源并发上限：来源 A 占满后，全局空位可由来源 B 占用。
func TestSourceConcurrencyLimit(t *testing.T) {
	cb := newCbCtl()
	cfg := Config{
		MaxConcurrent: 4,
		SourceLimits: map[string]SourceConfig{
			"A": {MaxConcurrent: 2},
			"B": {MaxConcurrent: 1},
		},
	}
	s, clk := newTestScheduler(t, cfg, cb.callback)
	now := clk.Now()

	for _, seq := range []int64{1, 2, 3} {
		cb.register(seq)
		mustSubmit(t, s, Task{Source: "A", Seq: seq, Ready: now})
	}
	cb.register(4)
	mustSubmit(t, s, Task{Source: "B", Seq: 4, Ready: now})

	waitFor(t, func() bool { return s.Running() == 3 }, "A*2 + B*1 running")
	assertNot(t, func() bool { return cb.startedCount() == 4 }, "third A blocked by source limit")

	cb.release(1)
	waitFor(t, func() bool { return cb.startedCount() == 4 }, "third A starts after A slot frees")
	cb.release(2)
	cb.release(3)
	cb.release(4)
	waitFor(t, func() bool { return s.Running() == 0 }, "all finish")
}

// 最小启动间隔按来源独立生效，且完成回调不会缩短间隔。
func TestMinStartInterval(t *testing.T) {
	cb := newCbCtl()
	cfg := Config{
		MaxConcurrent: 4,
		SourceLimits: map[string]SourceConfig{
			"A": {MaxConcurrent: 4, MinStartInterval: 10 * time.Second},
		},
	}
	s, clk := newTestScheduler(t, cfg, cb.callback)
	now := clk.Now()

	cb.registerDone(1)
	cb.registerDone(2)
	mustSubmit(t, s, Task{Source: "A", Seq: 1, Ready: now})
	mustSubmit(t, s, Task{Source: "A", Seq: 2, Ready: now})

	waitFor(t, func() bool { return cb.startedCount() == 1 }, "first task starts")
	waitFor(t, func() bool { return s.Running() == 0 }, "first callback returns")

	// Completion must not advance the interval: only 9s elapsed, still gated.
	clk.Advance(9 * time.Second)
	assertNot(t, func() bool { return cb.startedCount() == 2 }, "interval not yet elapsed")

	clk.Advance(time.Second)
	waitFor(t, func() bool { return cb.startedCount() == 2 }, "second starts after interval")
	waitFor(t, func() bool { return s.Pending() == 0 }, "queue drains")
}
