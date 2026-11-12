package dataeng

import (
	"context"
	"runtime"
	"testing"
	"time"
)

func TestNoGoroutineLeakOnClose(t *testing.T) {
	clk := NewFakeClock(time.Unix(0, 0))
	block := make(chan struct{})
	cb := func(ctx context.Context, task Task) {
		if task.Seq == 1 {
			<-block
		}
	}
	s, err := New(Config{
		MaxConcurrent: 2,
		SourceLimits: map[string]SourceConfig{
			"A": {MaxConcurrent: 1, MinStartInterval: time.Second},
		},
	}, clk, cb)
	if err != nil {
		t.Fatal(err)
	}
	now := clk.Now()
	for seq := int64(1); seq <= 5; seq++ {
		if _, err := s.Submit(Task{Source: "A", Seq: seq, Ready: now}); err != nil {
			t.Fatal(err)
		}
	}
	// Arm several interval/ready timers by advancing fake time.
	for i := 0; i < 5; i++ {
		clk.Advance(time.Second)
	}
	close(block)

	baseline := runtime.NumGoroutine()
	s.Close()

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		runtime.GC()
		if runtime.NumGoroutine() <= baseline {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("goroutine leak: before=%d after=%d", baseline, runtime.NumGoroutine())
}
