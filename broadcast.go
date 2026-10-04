// Package broadcast 提供多订阅者广播：每个订阅拥有独立的有界缓冲；
// 缓冲满时仅淘汰该订阅并记录终止原因；发布批次对存活订阅要么整批
// 接受、要么整批不投，绝不部分广播；每条消息携带全局单调递增序号，
// 订阅方据此可校验自己收到的是连续前缀。
package broadcast

import (
	"errors"
	"sync"
)

var (
	// ErrClosed 表示广播器已关闭：发布后调用返回该错误；
	// 也是订阅因广播器关闭而终止的原因。
	ErrClosed = errors.New("broadcast: closed")
	// ErrSlowConsumer 表示订阅因缓冲满、无法原子容纳整批而被淘汰。
	ErrSlowConsumer = errors.New("broadcast: slow consumer evicted")
)

// Message 是投递给订阅者的单元。Seq 为全局单调递增序号（从 1 开始），
// 同一订阅收到的消息序号必然构成 1..k 的连续前缀。
type Message[T any] struct {
	Seq   uint64
	Value T
}

// sub 是订阅的内部状态，reason 仅在 channel 关闭前、持锁时写入。
type sub[T any] struct {
	ch     chan Message[T]
	reason error
}

// Broadcaster 向所有存活订阅原子广播批次。零值不可用，请用 New 构造。
type Broadcaster[T any] struct {
	mu       sync.Mutex
	subs     map[*sub[T]]struct{}
	capacity int
	seq      uint64
	closed   bool
}

// New 创建广播器，capacity 为每个订阅各自的有界缓冲大小（>= 1）。
func New[T any](capacity int) *Broadcaster[T] {
	if capacity < 1 {
		panic("broadcast: capacity must be >= 1")
	}
	return &Broadcaster[T]{
		subs:     make(map[*sub[T]]struct{}),
		capacity: capacity,
	}
}

// Subscription 是某订阅者的句柄。
type Subscription[T any] struct {
	b *Broadcaster[T]
	s *sub[T]
}

// Subscribe 注册一个新订阅。若广播器已关闭，返回的订阅立即终止，
// 其 Err() 为 ErrClosed。
func (b *Broadcaster[T]) Subscribe() *Subscription[T] {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := &sub[T]{ch: make(chan Message[T], b.capacity)}
	if b.closed {
		s.reason = ErrClosed
		close(s.ch)
	} else {
		b.subs[s] = struct{}{}
	}
	return &Subscription[T]{b: b, s: s}
}

// Publish 原子地广播一个批次：先淘汰缓冲不足以容纳整批的订阅
// （仅淘汰这些订阅，原因记为 ErrSlowConsumer，且它们对本批一条不收），
// 再把整批投递给其余所有存活订阅。投递在持锁状态下完成且容量已预留，
// 因此对每个存活订阅要么整批接受、要么整批不投，绝不部分广播。
// 广播器关闭后调用返回 ErrClosed，本批对任何人都不投递。
// 批长大于订阅缓冲容量时，所有订阅都会被淘汰。
func (b *Broadcaster[T]) Publish(values ...T) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return ErrClosed
	}
	if len(values) == 0 {
		return nil
	}
	for s := range b.subs {
		if cap(s.ch)-len(s.ch) < len(values) {
			s.reason = ErrSlowConsumer
			close(s.ch)
			delete(b.subs, s)
		}
	}
	msgs := make([]Message[T], len(values))
	for i, v := range values {
		b.seq++
		msgs[i] = Message[T]{Seq: b.seq, Value: v}
	}
	for s := range b.subs {
		for _, m := range msgs {
			s.ch <- m // 容量已预留，发送永不阻塞
		}
	}
	return nil
}

// Close 关闭广播器：所有存活订阅以 ErrClosed 终止，后续 Publish
// 一律返回 ErrClosed。重复调用是安全的。
func (b *Broadcaster[T]) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	for s := range b.subs {
		s.reason = ErrClosed
		close(s.ch)
		delete(b.subs, s)
	}
}

// C 返回接收通道。通道关闭表示订阅已终止，此后 Err() 返回终止原因。
func (s *Subscription[T]) C() <-chan Message[T] {
	return s.s.ch
}

// Err 返回订阅的终止原因：ErrSlowConsumer（缓冲满被淘汰）或
// ErrClosed（广播器关闭）；主动 Unsubscribe 终止时为 nil。
// 仅在 C() 关闭后调用才有意义。
func (s *Subscription[T]) Err() error {
	s.b.mu.Lock()
	defer s.b.mu.Unlock()
	return s.s.reason
}

// Unsubscribe 主动退订：通道被关闭，不再接收任何消息。
func (s *Subscription[T]) Unsubscribe() {
	s.b.mu.Lock()
	defer s.b.mu.Unlock()
	if _, ok := s.b.subs[s.s]; ok {
		delete(s.b.subs, s.s)
		close(s.s.ch)
	}
}
