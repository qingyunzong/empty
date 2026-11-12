package dataeng

import (
	"testing"
	"time"
)

// 动态降低限额：已运行任务不中断；新限额只约束更新后的启动。
func TestUpdateLimitsLowerGlobal(t *testing.T) {
	cb := newCbCtl()
	cfg := Config{MaxConcurrent: 4}
	s, clk := newTestScheduler(t, cfg, cb.callback)
	now := clk.Now()

	for seq := int64(1); seq <= 6; seq++ {
		cb.register(seq)
		mustSubmit(t, s, Task{Source: "A", Seq: seq, Ready: now})
	}
	waitFor(t, func() bool { return s.Running() == 4 }, "four running under old limit")

	if err := s.UpdateLimits(Config{MaxConcurrent: 1}); err != nil {
		t.Fatalf("UpdateLimits: %v", err)
	}

	// The four already-running tasks keep running; nothing new starts.
	assertNot(t, func() bool { return cb.startedCount() > 4 }, "no new starts above lowered limit")
	if s.Running() != 4 {
		t.Fatalf("running = %d, running tasks must not be aborted", s.Running())
	}

	cb.release(1)
	waitFor(t, func() bool { return s.Running() == 3 }, "one finishes")
	assertNot(t, func() bool { return cb.startedCount() > 4 }, "still no new start while running >= new limit")

	cb.release(2)
	cb.release(3)
	waitFor(t, func() bool { return s.Running() == 1 }, "three finish, running now equals new limit")
	assertNot(t, func() bool { return cb.startedCount() > 4 }, "new limit of 1 blocks the next start")

	cb.release(4)
	waitFor(t, func() bool { return cb.startedCount() == 5 && s.Running() == 1 }, "one task starts under new limit")

	// Raising the limit again allows the last pending task to start.
	if err := s.UpdateLimits(Config{MaxConcurrent: 4}); err != nil {
		t.Fatalf("UpdateLimits raise: %v", err)
	}
	waitFor(t, func() bool { return cb.startedCount() == 6 }, "last task starts after raise")
	cb.release(5)
	cb.release(6)
	waitFor(t, func() bool { return s.Running() == 0 && s.Pending() == 0 }, "drain")
}

// 动态收紧来源限额与新增最小间隔，同样只约束更新后的启动。
func TestUpdateLimitsSourceTightening(t *testing.T) {
	cb := newCbCtl()
	cfg := Config{
		MaxConcurrent: 8,
		SourceLimits: map[string]SourceConfig{
			"A": {MaxConcurrent: 4},
		},
	}
	s, clk := newTestScheduler(t, cfg, cb.callback)
	t0 := clk.Now()

	for seq := int64(1); seq <= 2; seq++ {
		cb.register(seq)
		mustSubmit(t, s, Task{Source: "A", Seq: seq, Ready: t0})
	}
	waitFor(t, func() bool { return s.Running() == 2 }, "two A tasks running")

	// Tighten A to a single slot and add an interval measured from now.
	if err := s.UpdateLimits(Config{
		MaxConcurrent: 8,
		SourceLimits: map[string]SourceConfig{
			"A": {MaxConcurrent: 1, MinStartInterval: 5 * time.Second},
		},
	}); err != nil {
		t.Fatalf("UpdateLimits: %v", err)
	}

	// Submitted after the update, so it is governed by the new limits.
	cb.registerDone(4)
	mustSubmit(t, s, Task{Source: "A", Seq: 4, Ready: t0})
	assertNot(t, func() bool { return cb.startedCount() == 3 }, "seq 4 blocked by tightened source limit")

	cb.release(1)
	waitFor(t, func() bool { return s.Running() == 1 }, "one finishes; seq 2 keeps the single slot")
	assertNot(t, func() bool { return cb.startedCount() == 3 }, "min interval still blocks seq 4")

	cb.release(2)
	waitFor(t, func() bool { return s.Running() == 0 }, "seq 2 finishes, slot free but interval unmet")
	assertNot(t, func() bool { return cb.startedCount() == 3 }, "seq 4 waits for interval")

	// Interval is measured from the source's last start (t0); 5s total
	// fake time must elapse before another A task may start.
	clk.Advance(5 * time.Second)
	waitFor(t, func() bool { return cb.startedCount() == 3 }, "seq 4 starts after interval")
	if last := cb.startOrder(); last[len(last)-1] != 4 {
		t.Fatalf("last started = %v, want seq 4", last)
	}
	waitFor(t, func() bool { return s.Running() == 0 && s.Pending() == 0 }, "drain")
}

func TestUpdateLimitsRejectsInvalid(t *testing.T) {
	cb := newCbCtl()
	s, _ := newTestScheduler(t, Config{MaxConcurrent: 1}, cb.callback)
	if err := s.UpdateLimits(Config{MaxConcurrent: 0}); err == nil {
		t.Fatal("expected error for non-positive global limit")
	}
	if err := s.UpdateLimits(Config{
		MaxConcurrent: 1,
		SourceLimits:  map[string]SourceConfig{"A": {MaxConcurrent: -1}},
	}); err == nil {
		t.Fatal("expected error for negative source limit")
	}
}
