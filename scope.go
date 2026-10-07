// Package resourceblock 提供“资源块”：块内登记的资源在块退出时按
// 后入先出（LIFO）顺序清理。无论块以正常 return、错误、panic 还是
// context 取消结束，清理都会执行；清理失败时保留主错误并附上从错误；
// 清理回调中再登记的资源会在本块退出前一并清理；整个过程输出事件轨迹。
package resourceblock

import (
	"context"
	"fmt"
	"sync"
)

// CleanupFunc 是资源的清理回调。ctx 与触发清理的 context 解除了取消
// （即使块因取消而退出，清理也不会被取消）；s 仍为打开状态，回调中
// 可继续 Defer 新资源，这些资源会在本块退出前被清理。
type CleanupFunc func(ctx context.Context, s *Scope) error

type cleanupEntry struct {
	name string
	fn   CleanupFunc
}

// Scope 是一个资源块。通过 Run / RunTraced 创建，仅在块执行期间有效。
type Scope struct {
	mu     sync.Mutex
	stack  []cleanupEntry
	closed bool
	events []Event
}

// Defer 受控登记一个资源及其清理回调：nil 回调返回 ErrNilCleanup；
// 块已退出后登记返回 ErrScopeClosed。登记即产生一条 EventAcquire。
func (s *Scope) Defer(name string, fn CleanupFunc) error {
	if fn == nil {
		return ErrNilCleanup
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrScopeClosed
	}
	s.stack = append(s.stack, cleanupEntry{name: name, fn: fn})
	s.recordLocked(Event{Kind: EventAcquire, Name: name})
	return nil
}

// Events 返回迄今为止的事件轨迹副本。
func (s *Scope) Events() []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Event(nil), s.events...)
}

func (s *Scope) recordLocked(e Event) {
	e.Seq = len(s.events)
	s.events = append(s.events, e)
}

func (s *Scope) record(e Event) {
	s.mu.Lock()
	s.recordLocked(e)
	s.mu.Unlock()
}

// drain 按 LIFO 弹出并执行清理，直到栈空。清理回调中新登记的资源
// 会入栈并在同一轮退出前被清理。单个清理的 panic 被转为从错误。
func (s *Scope) drain(ctx context.Context) []error {
	var errs []error
	for {
		s.mu.Lock()
		if len(s.stack) == 0 {
			s.closed = true
			s.mu.Unlock()
			return errs
		}
		entry := s.stack[len(s.stack)-1]
		s.stack = s.stack[:len(s.stack)-1]
		s.mu.Unlock()

		if err := callCleanup(ctx, s, entry); err != nil {
			wrapped := fmt.Errorf("cleanup %q: %w", entry.name, err)
			errs = append(errs, wrapped)
			s.record(Event{Kind: EventReleaseFailed, Name: entry.name, Err: err})
		} else {
			s.record(Event{Kind: EventRelease, Name: entry.name})
		}
	}
}

func callCleanup(ctx context.Context, s *Scope, entry cleanupEntry) (err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("panic: %v", p)
		}
	}()
	return entry.fn(ctx, s)
}

// Run 在资源块中执行 fn，退出时按 LIFO 清理全部资源，返回合并后的错误。
func Run(ctx context.Context, fn func(s *Scope) error) error {
	_, err := RunTraced(ctx, fn)
	return err
}

// RunTraced 同 Run，但额外返回本次执行的事件轨迹。
//
// 退出语义：
//   - 正常 return / 返回错误 / panic / ctx 取消：都会先完成 LIFO 清理。
//   - fn 返回的错误是主错误；fn 返回 nil 但 ctx 已取消时，ctx.Err() 成为主错误。
//   - 清理失败产生从错误，与主错误一起包进 *ExitError 返回。
//   - fn panic 时：清理照常执行（失败记入轨迹），随后以原 panic 值继续 panic。
func RunTraced(ctx context.Context, fn func(s *Scope) error) (events []Event, err error) {
	s := &Scope{}
	cleanupCtx := context.WithoutCancel(ctx)

	defer func() {
		cleanupErrs := s.drain(cleanupCtx)
		events = s.Events()
		if p := recover(); p != nil {
			panic(p) // 保留主 panic；清理失败已记录在事件轨迹中
		}
		if err == nil {
			err = ctx.Err() // 取消路径：取消本身成为主错误
		}
		if len(cleanupErrs) > 0 {
			err = &ExitError{Primary: err, Cleanup: cleanupErrs}
		}
	}()

	err = fn(s)
	return nil, err
}
