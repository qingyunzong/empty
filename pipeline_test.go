package pipeline

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

// 关闭入口后，必须等待所有已接受任务及其全部后继结束。
func TestCloseWaitsForAllDescendants(t *testing.T) {
	p := New()
	var processed atomic.Int64

	// 二叉树：stage 0..3 各派生两个下一阶段子任务，共 2^5-1 = 31 个任务。
	p.Register(0, treeHandler(0, 4, &processed))
	p.Register(1, treeHandler(1, 4, &processed))
	p.Register(2, treeHandler(2, 4, &processed))
	p.Register(3, treeHandler(3, 4, &processed))
	p.Register(4, treeHandler(4, 4, &processed))

	if err := p.Submit(Task{Stage: 0}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	p.Close() // 立即关闭入口，后继任务仍在不断派生

	stats := p.Wait()
	if got := processed.Load(); got != 31 {
		t.Fatalf("processed = %d, want 31 (Wait 提前返回，未等后继结束)", got)
	}
	if stats.Submitted != 31 || stats.Completed != 31 || stats.Failed != 0 {
		t.Fatalf("stats = %+v, want {31 31 0}", stats)
	}
	if err := p.Err(); err != nil {
		t.Fatalf("Err = %v, want nil", err)
	}
}

func treeHandler(stage, maxStage int, counter *atomic.Int64) Handler {
	return func(ctx context.Context, task Task) ([]Task, error) {
		counter.Add(1)
		if stage == maxStage {
			return nil, nil
		}
		return []Task{{Stage: stage + 1}, {Stage: stage + 1}}, nil
	}
}

// 关键竞态：任一时刻只有一个在途任务，且它在即将完成的最后一刻
// 才派生新任务。若用“队列瞬时为空调”判完成，Wait 会在链式派生的
// 间隙提前返回。这里必须跑完全部 depth 个任务。
func TestDeriveJustBeforeLastTaskCompletes(t *testing.T) {
	const depth = 500
	p := New()
	var processed atomic.Int64

	var h Handler
	h = func(ctx context.Context, task Task) ([]Task, error) {
		n := processed.Add(1)
		// 拉大“队列空但派生未发生”的窗口，放大竞态。
		time.Sleep(time.Millisecond)
		if n == depth {
			return nil, nil // 最后一个任务，不再派生
		}
		return []Task{{Stage: 0}}, nil // 完成前一刻派生后继
	}
	p.Register(0, h)

	if err := p.Submit(Task{Stage: 0}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	stats := p.Wait()
	if got := processed.Load(); got != depth {
		t.Fatalf("processed = %d, want %d (最后任务完成前派生的任务被丢弃)", got, depth)
	}
	if stats.Submitted != depth || stats.Completed != depth || stats.Failed != 0 {
		t.Fatalf("stats = %+v, want {%d %d 0}", stats, depth, depth)
	}
}

// 失败必须停止继续派生：兄弟任务失败后，慢任务返回的下游任务不得执行；
// 已被接受的任务仍跑完，事件计数保持守恒。
func TestFailureStopsDerivation(t *testing.T) {
	boom := errors.New("boom")
	p := New()
	var stage2Ran atomic.Int64

	p.Register(0, func(ctx context.Context, task Task) ([]Task, error) {
		return []Task{{Stage: 1, Value: "fail"}, {Stage: 1, Value: "slow"}}, nil
	})
	p.Register(1, func(ctx context.Context, task Task) ([]Task, error) {
		if task.Value == "fail" {
			return nil, boom
		}
		time.Sleep(50 * time.Millisecond) // 等失败先发生
		return []Task{{Stage: 2}}, nil    // 失败后派生，必须被拒绝
	})
	p.Register(2, func(ctx context.Context, task Task) ([]Task, error) {
		stage2Ran.Add(1)
		return nil, nil
	})

	if err := p.Submit(Task{Stage: 0}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	stats := p.Wait()

	if !errors.Is(p.Err(), boom) {
		t.Fatalf("Err = %v, want boom", p.Err())
	}
	if got := stage2Ran.Load(); got != 0 {
		t.Fatalf("stage2 ran %d times, want 0 (失败后仍在派生)", got)
	}
	// 守恒：root 完成 + fail 失败 + slow 完成 = 3 个已接受任务。
	if stats.Submitted != 3 || stats.Completed != 2 || stats.Failed != 1 {
		t.Fatalf("stats = %+v, want {3 2 1}", stats)
	}
	if stats.Submitted != stats.Completed+stats.Failed {
		t.Fatalf("计数不守恒: %+v", stats)
	}
}

// 入口关闭后再提交必须被拒绝。
func TestSubmitAfterCloseRejected(t *testing.T) {
	p := New()
	p.Register(0, func(ctx context.Context, task Task) ([]Task, error) { return nil, nil })
	if err := p.Submit(Task{Stage: 0}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	p.Close()
	if err := p.Submit(Task{Stage: 0}); !errors.Is(err, ErrClosed) {
		t.Fatalf("submit after close = %v, want ErrClosed", err)
	}
	p.Wait()
}

// 混合成功与失败的随机形树，验证事件计数守恒与处理总数一致。
func TestStatsConservationWithMixedFailures(t *testing.T) {
	p := New()
	var processed atomic.Int64
	failAt := map[int]bool{3: true, 7: true, 13: true}

	var h Handler
	h = func(ctx context.Context, task Task) ([]Task, error) {
		n := int(processed.Add(1))
		if failAt[n] {
			return nil, errors.New("task failed")
		}
		if n >= 20 {
			return nil, nil
		}
		return []Task{{Stage: 0}, {Stage: 0}}, nil
	}
	p.Register(0, h)

	if err := p.Submit(Task{Stage: 0}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	stats := p.Wait()

	if stats.Submitted != stats.Completed+stats.Failed {
		t.Fatalf("计数不守恒: %+v", stats)
	}
	if got := processed.Load(); got != stats.Submitted {
		t.Fatalf("processed = %d, want %d (已接受任务未全部执行)", got, stats.Submitted)
	}
	if stats.Failed == 0 {
		t.Fatalf("expected some failures, got %+v", stats)
	}
	if p.Err() == nil {
		t.Fatal("Err = nil, want non-nil")
	}
}
