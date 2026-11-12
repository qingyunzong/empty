package dataeng

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestNewValidation(t *testing.T) {
	clk := NewFakeClock(time.Unix(0, 0))
	cb := func(context.Context, Task) {}
	if _, err := New(Config{MaxConcurrent: 0}, clk, cb); err == nil {
		t.Fatal("expected error for non-positive global limit")
	}
	if _, err := New(Config{MaxConcurrent: 1}, clk, nil); err == nil {
		t.Fatal("expected error for nil callback")
	}
	if _, err := New(Config{MaxConcurrent: 1}, nil, cb); err == nil {
		t.Fatal("expected error for nil clock")
	}
	if _, err := New(Config{
		MaxConcurrent: 1,
		SourceLimits:  map[string]SourceConfig{"A": {MinStartInterval: -1}},
	}, clk, cb); err == nil {
		t.Fatal("expected error for negative interval")
	}
}

func TestSubmitAndCloseErrors(t *testing.T) {
	cb := newCbCtl()
	s, clk := newTestScheduler(t, Config{MaxConcurrent: 1}, cb.callback)
	now := clk.Now()

	cb.registerDone(1)
	mustSubmit(t, s, Task{Source: "A", Seq: 1, Ready: now})
	if _, err := s.Submit(Task{Source: "A", Seq: 1, Ready: now}); !errors.Is(err, ErrDuplicateSeq) {
		t.Fatalf("duplicate submit err = %v, want ErrDuplicateSeq", err)
	}
	clk.Advance(time.Second)

	waitFor(t, func() bool { return s.Running() == 0 }, "task completes")
	// Once the finished entry is fully removed, the seq can be reused.
	deadline := time.Now().Add(testTimeout)
	for {
		if _, err := s.Submit(Task{Source: "A", Seq: 1, Ready: clk.Now()}); err == nil {
			break
		} else if !errors.Is(err, ErrDuplicateSeq) {
			t.Fatalf("reuse finished seq: %v", err)
		}
		if time.Now().After(deadline) {
			t.Fatal("finished seq was never released for reuse")
		}
		time.Sleep(time.Millisecond)
	}
	waitFor(t, func() bool { return s.Running() == 0 }, "reused task completes")

	s.Close()
	if _, err := s.Submit(Task{Source: "A", Seq: 99, Ready: clk.Now()}); !errors.Is(err, ErrClosed) {
		t.Fatalf("submit after close err = %v, want ErrClosed", err)
	}
	if err := s.Cancel(99); !errors.Is(err, ErrClosed) {
		t.Fatalf("cancel after close err = %v, want ErrClosed", err)
	}
	if err := s.UpdateLimits(Config{MaxConcurrent: 2}); !errors.Is(err, ErrClosed) {
		t.Fatalf("update after close err = %v, want ErrClosed", err)
	}
	// Close is idempotent.
	s.Close()
}

// Close 等待所有在途回调结束，且待启动任务不再执行。
func TestCloseWaitsForInflightAndDropsPending(t *testing.T) {
	var ran int32
	block := make(chan struct{})
	cb := func(_ context.Context, task Task) {
		if task.Seq == 1 {
			<-block
		}
		atomic.AddInt32(&ran, 1)
	}
	clk := NewFakeClock(time.Unix(0, 0))
	s, err := New(Config{MaxConcurrent: 1}, clk, cb)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if _, err := s.Submit(Task{Source: "A", Seq: 1, Ready: clk.Now()}); err != nil {
		t.Fatalf("submit 1: %v", err)
	}
	if _, err := s.Submit(Task{Source: "A", Seq: 2, Ready: clk.Now().Add(time.Hour)}); err != nil {
		t.Fatalf("submit 2: %v", err)
	}
	waitFor(t, func() bool { return s.Running() == 1 }, "seq 1 running")

	done := make(chan struct{})
	go func() {
		s.Close()
		close(done)
	}()
	select {
	case <-done:
		t.Fatal("Close returned while callback still in flight")
	case <-time.After(20 * time.Millisecond):
	}

	close(block)
	<-done
	if got := atomic.LoadInt32(&ran); got != 1 {
		t.Fatalf("ran = %d, pending task must not start after Close", got)
	}
}

// 回调 panic 不会泄漏额度，也不会拖垮调度器。
func TestCallbackPanicReleasesQuota(t *testing.T) {
	cb := newCbCtl()
	s, clk := newTestScheduler(t, Config{MaxConcurrent: 1}, func(ctx context.Context, task Task) {
		if task.Seq == 1 {
			panic("boom")
		}
		cb.callback(ctx, task)
	})
	now := clk.Now()
	cb.registerDone(2)
	mustSubmit(t, s, Task{Source: "A", Seq: 1, Ready: now})
	mustSubmit(t, s, Task{Source: "A", Seq: 2, Ready: now})

	waitFor(t, func() bool { return cb.startedCount() == 1 }, "seq 2 starts after panicking task released quota")
	waitFor(t, func() bool { return s.Running() == 0 }, "drain")
}
