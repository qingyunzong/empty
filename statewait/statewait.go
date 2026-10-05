// Package statewait 提供基于版本号的状态等待原语。
//
// Waiter 允许调用者等待版本号超过指定阈值。订阅登记与版本更新
// 在同一把互斥锁下完成，因此二者是原子的：更新发生时，要么
// 等待者已经登记并能收到通知，要么尚未登记并能在登记时直接
// 观察到新版本，不存在丢失唤醒的窗口。
//
// 取消与更新发生竞争时，先在锁内完成的一方生效：若更新已送达
// 订阅，则等待返回新版本；否则取消生效，返回上下文错误。
// Close 之后所有阻塞中的 Wait 立即退出，后续 Wait 立即返回
// ErrClosed。
package statewait

import (
	"context"
	"errors"
	"sync"
)

// ErrClosed 在 Waiter 已关闭时由 Wait 返回。
var ErrClosed = errors.New("statewait: waiter closed")

// Waiter 跟踪一个单调递增的版本号，并唤醒等待更高版本的调用者。
// 零值不可用，请使用 New 构造。
type Waiter struct {
	mu      sync.Mutex
	version uint64
	closed  bool
	subs    map[*subscription]struct{}
}

// subscription 表示一次已登记的等待。ch 缓冲为 1，Update 与
// Close 在锁内投递，因此发送永不阻塞。
type subscription struct {
	threshold uint64
	ch        chan uint64
	done      bool // 更新或关闭已在锁内完成投递
}

// New 返回一个初始版本为 0 的 Waiter。
func New() *Waiter {
	return &Waiter{subs: make(map[*subscription]struct{})}
}

// Version 返回当前版本号。
func (w *Waiter) Version() uint64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.version
}

// Update 在 v 大于当前版本时推进版本并唤醒所有阈值低于 v 的
// 等待者，返回 true；v 不大于当前版本（包括重复同版本）或
// Waiter 已关闭时不产生任何通知，返回 false。
func (w *Waiter) Update(v uint64) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed || v <= w.version {
		return false
	}
	w.version = v
	for s := range w.subs {
		if s.threshold < v {
			s.ch <- v
			s.done = true
			delete(w.subs, s)
		}
	}
	return true
}

// Close 关闭 Waiter：所有阻塞中的 Wait 立即以 ErrClosed 退出，
// 之后的 Wait 与 Update 不再生效。重复调用安全。
func (w *Waiter) Close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	w.closed = true
	for s := range w.subs {
		close(s.ch)
		s.done = true
		delete(w.subs, s)
	}
}

// Wait 阻塞直到版本号大于 threshold、ctx 被取消或 Waiter 被关闭。
//
// 若登记时当前版本已大于 threshold，立即返回当前版本。取消与
// 更新竞争时按先完成者返回：更新已送达则返回新版本与 nil 错误，
// 否则返回 ctx.Err()。关闭时返回 ErrClosed。
func (w *Waiter) Wait(ctx context.Context, threshold uint64) (uint64, error) {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return 0, ErrClosed
	}
	if w.version > threshold {
		v := w.version
		w.mu.Unlock()
		return v, nil
	}
	s := &subscription{threshold: threshold, ch: make(chan uint64, 1)}
	w.subs[s] = struct{}{}
	w.mu.Unlock()

	select {
	case v, ok := <-s.ch:
		if !ok {
			return 0, ErrClosed
		}
		return v, nil
	case <-ctx.Done():
		w.mu.Lock()
		if s.done {
			// 更新或关闭已先完成投递，先完成者生效。
			w.mu.Unlock()
			v, ok := <-s.ch
			if !ok {
				return 0, ErrClosed
			}
			return v, nil
		}
		delete(w.subs, s)
		s.done = true
		w.mu.Unlock()
		return 0, ctx.Err()
	}
}
