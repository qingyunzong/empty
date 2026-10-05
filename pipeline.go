// Package pipeline 提供一个并发任务流水线：每个阶段的处理器可以派生
// 下游任务。关闭入口（Close）后，Wait 会等待所有已接受任务及其全部
// 后继任务结束。完成判定基于在途任务计数（sync.WaitGroup），子任务
// 在父任务归还计数之前就被计入，因此计数器不会在派生间隙瞬时归零，
// 绝不使用“队列瞬时为空调”作为完成条件。
//
// 任一任务失败会记录首个错误并取消上下文，此后停止继续派生新任务；
// 已被接受的任务仍会跑完并计入统计。事件计数守恒：Wait 返回时恒有
// Submitted == Completed + Failed。
package pipeline

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// ErrClosed 表示入口已关闭，不再接受外部提交。
var ErrClosed = errors.New("pipeline: entry closed")

// ErrFailed 表示流水线已失败，不再派生新任务。
var ErrFailed = errors.New("pipeline: already failed")

// Task 是流水线中流转的任务，Stage 决定由哪个处理器执行。
type Task struct {
	Stage int
	Value any
}

// Handler 处理一个任务，返回需要派生的下游任务列表。
// 返回的下游任务会在当前任务归还计数前被接受，保证计数守恒。
type Handler func(ctx context.Context, t Task) ([]Task, error)

// Stats 是事件计数，守恒不变式：Submitted == Completed + Failed。
type Stats struct {
	Submitted int64 // 被接受（提交或派生成功）的任务数
	Completed int64 // 处理成功完成的任务数
	Failed    int64 // 处理失败的任务数
}

// Pipeline 是并发流水线。零值不可用，请使用 New 构造。
type Pipeline struct {
	mu       sync.Mutex
	handlers map[int]Handler
	closed   bool
	firstErr error
	stats    Stats

	ctx    context.Context
	cancel context.CancelFunc

	inflight sync.WaitGroup // 在途（已接受未结束）任务计数
	done     chan struct{}
	waitOnce sync.Once
}

// New 创建一个空流水线。
func New() *Pipeline {
	ctx, cancel := context.WithCancel(context.Background())
	return &Pipeline{
		handlers: make(map[int]Handler),
		ctx:      ctx,
		cancel:   cancel,
		done:     make(chan struct{}),
	}
}

// Register 为某个阶段注册处理器，重复注册会覆盖。
func (p *Pipeline) Register(stage int, h Handler) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.handlers[stage] = h
}

// Submit 从入口提交一个任务。入口关闭或流水线已失败后返回错误。
func (p *Pipeline) Submit(t Task) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return ErrClosed
	}
	return p.acceptLocked(t)
}

// acceptLocked 接受一个任务并派发给后台 goroutine。
// 调用者必须持有 p.mu。计数先加一，保证父任务归还计数前子任务已入账。
func (p *Pipeline) acceptLocked(t Task) error {
	if p.firstErr != nil {
		return ErrFailed
	}
	if _, ok := p.handlers[t.Stage]; !ok {
		return fmt.Errorf("pipeline: no handler for stage %d", t.Stage)
	}
	p.stats.Submitted++
	p.inflight.Add(1)
	go p.run(t)
	return nil
}

// run 执行单个任务：先处理，再在归还计数前接受全部派生任务。
func (p *Pipeline) run(t Task) {
	defer p.inflight.Done()

	p.mu.Lock()
	h := p.handlers[t.Stage]
	p.mu.Unlock()

	children, err := h(p.ctx, t)

	p.mu.Lock()
	defer p.mu.Unlock()
	if err != nil {
		p.stats.Failed++
		if p.firstErr == nil {
			p.firstErr = err
			p.cancel() // 通知仍在运行的处理器尽快停止
		}
		return
	}
	p.stats.Completed++
	if p.firstErr != nil {
		return // 已有失败：停止继续派生
	}
	for _, child := range children {
		if aerr := p.acceptLocked(child); aerr != nil && p.firstErr == nil {
			p.firstErr = aerr
			p.cancel()
		}
	}
}

// Close 关闭入口，之后 Submit 返回 ErrClosed；已接受的任务及其
// 后继不受影响，会继续运行直至全部结束。
func (p *Pipeline) Close() {
	p.mu.Lock()
	p.closed = true
	p.mu.Unlock()
	p.waitOnce.Do(func() {
		go func() {
			p.inflight.Wait()
			p.cancel()
			close(p.done)
		}()
	})
}

// Wait 关闭入口并阻塞，直到所有已接受任务及其全部后继结束，
// 返回最终的事件计数（满足 Submitted == Completed + Failed）。
func (p *Pipeline) Wait() Stats {
	p.Close()
	<-p.done
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.stats
}

// Err 返回首个导致流水线失败的错误；无错误时返回 nil。
func (p *Pipeline) Err() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.firstErr
}
