package proxy

import "sync"

// State 是受控 Promise 的结算状态枚举。
type State int

const (
	// Pending 表示尚未结算。
	Pending State = iota
	// Fulfilled 表示已成功结算。
	Fulfilled
	// Rejected 表示已失败结算。
	Rejected
)

func (s State) String() string {
	switch s {
	case Pending:
		return "Pending"
	case Fulfilled:
		return "Fulfilled"
	case Rejected:
		return "Rejected"
	default:
		return "Unknown"
	}
}

// Promise 是一次性结算的受控 Promise：首个 Resolve/Reject 生效，
// 之后的迟到完成（late completion）一律被忽略并返回 false。
type Promise[T any] struct {
	mu    sync.Mutex
	state State
	val   T
	err   error
	done  chan struct{}
}

// NewPromise 返回一个处于 Pending 状态的 Promise。
func NewPromise[T any]() *Promise[T] {
	return &Promise[T]{done: make(chan struct{})}
}

// Resolve 尝试以成功值结算；若已结算（迟到完成）则忽略并返回 false。
func (p *Promise[T]) Resolve(v T) bool {
	return p.settle(Fulfilled, v, nil)
}

// Reject 尝试以错误结算；若已结算（迟到完成）则忽略并返回 false。
func (p *Promise[T]) Reject(err error) bool {
	var zero T
	return p.settle(Rejected, zero, err)
}

func (p *Promise[T]) settle(s State, v T, err error) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.state != Pending {
		return false
	}
	p.state, p.val, p.err = s, v, err
	close(p.done)
	return true
}

// Wait 阻塞直至结算，返回结果值与错误。
func (p *Promise[T]) Wait() (T, error) {
	<-p.done
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.val, p.err
}

// State 返回当前结算状态。
func (p *Promise[T]) State() State {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.state
}
