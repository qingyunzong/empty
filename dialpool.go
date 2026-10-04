// Package dialpool 提供带容量上限的连接拨号池。
//
// 池在容量未满时先预留槽位，再异步拨号；等待者超时后，迟到完成的
// 连接会被归池复用或销毁，绝不会交付给已过期的票据；池关闭后，
// 一切迟到结果一律销毁。
package dialpool

import (
	"context"
	"errors"
	"io"
	"sync"
)

// ErrClosed 在池已关闭后获取连接时返回。
var ErrClosed = errors.New("dialpool: pool is closed")

// DialFunc 拨号函数。池以 context.Background() 调用它：拨号生命周期
// 独立于单个等待者的 ctx，这样超时的等待者不会杀死可被复用的连接。
type DialFunc func(ctx context.Context) (io.Closer, error)

// dialResult 是一次拨号或交付的结果。
type dialResult struct {
	conn io.Closer
	err  error
}

// ticket 表示一次待交付的取连接请求。settled 与 ch 的发送
// 都只在 Pool.mu 保护下发生，保证每个票据至多交付一次。
type ticket struct {
	ch      chan dialResult // 容量 1
	settled bool
}

// Pool 是有容量上限的连接池。
type Pool struct {
	dial DialFunc
	cap  int

	mu      sync.Mutex
	open    int // 已占用槽位：空闲 + 借出 + 拨号中
	idle    []io.Closer
	waiters []*ticket
	closed  bool
}

// New 创建容量为 capacity 的池。
func New(capacity int, dial DialFunc) *Pool {
	if capacity <= 0 {
		panic("dialpool: capacity must be positive")
	}
	if dial == nil {
		panic("dialpool: dial func must not be nil")
	}
	return &Pool{dial: dial, cap: capacity}
}

// Get 取出一个连接，优先复用空闲连接；容量未满时预留槽位并异步
// 拨号；容量已满则排队等待他人归还。ctx 超时返回 ctx.Err()，
// 迟到的连接会被归池或销毁，不会交付给本票据。
func (p *Pool) Get(ctx context.Context) (io.Closer, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, ErrClosed
	}
	if n := len(p.idle); n > 0 {
		c := p.idle[n-1]
		p.idle = p.idle[:n-1]
		p.mu.Unlock()
		return c, nil
	}
	t := &ticket{ch: make(chan dialResult, 1)}
	if p.open < p.cap {
		p.open++ // 先预留槽位
		go p.dialAsync(t)
	} else {
		p.waiters = append(p.waiters, t)
	}
	p.mu.Unlock()

	select {
	case res := <-t.ch:
		return res.conn, res.err
	case <-ctx.Done():
		p.mu.Lock()
		t.settled = true
		var toClose io.Closer
		select {
		case res := <-t.ch:
			// 与交付赛跑输了：连接已到但票据已过期，回收之。
			// 若是拨号错误，槽位已由 dialAsync 释放，无需处理。
			if res.conn != nil {
				toClose = p.reuseLocked(res.conn)
			}
		default:
		}
		p.mu.Unlock()
		if toClose != nil {
			toClose.Close()
		}
		return nil, ctx.Err()
	}
}

// Put 归还连接。连接被直接交给等待者或进入空闲列表；
// 池已关闭时连接被销毁。
func (p *Pool) Put(conn io.Closer) {
	if conn == nil {
		return
	}
	p.mu.Lock()
	toClose := p.reuseLocked(conn)
	p.mu.Unlock()
	if toClose != nil {
		toClose.Close()
	}
}

// Close 关闭池：销毁空闲连接，唤醒所有等待者并返回 ErrClosed。
// 借出的连接归还时销毁，拨号中的迟到结果完成时销毁。
func (p *Pool) Close() error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	idle := p.idle
	p.idle = nil
	p.open -= len(idle)
	for _, w := range p.waiters {
		if !w.settled {
			w.settled = true
			w.ch <- dialResult{err: ErrClosed}
		}
	}
	p.waiters = nil
	p.mu.Unlock()
	for _, c := range idle {
		c.Close()
	}
	return nil
}

// Stats 返回当前占用的槽位数、空闲连接数和排队等待者数。
func (p *Pool) Stats() (open, idle, waiters int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.open, len(p.idle), len(p.waiters)
}

// dialAsync 异步拨号并在完成后交付或回收结果。
func (p *Pool) dialAsync(t *ticket) {
	conn, err := p.dial(context.Background())
	p.mu.Lock()
	if err != nil {
		p.open-- // 释放预留的槽位
		if !t.settled {
			t.settled = true
			t.ch <- dialResult{err: err}
		}
		p.mu.Unlock()
		return
	}
	if t.settled {
		// 等待者已超时：迟到连接归池或销毁，绝不交付给过期票据。
		toClose := p.reuseLocked(conn)
		p.mu.Unlock()
		if toClose != nil {
			toClose.Close()
		}
		return
	}
	if p.closed {
		// 关闭后迟到结果一律销毁。
		p.open--
		t.settled = true
		t.ch <- dialResult{err: ErrClosed}
		p.mu.Unlock()
		conn.Close()
		return
	}
	t.settled = true
	t.ch <- dialResult{conn: conn}
	p.mu.Unlock()
}

// reuseLocked 把连接交给下一个等待者、放入空闲列表，或在池关闭时
// 返回它以便调用方解锁后销毁。调用时必须持有 p.mu。
func (p *Pool) reuseLocked(c io.Closer) (toClose io.Closer) {
	if p.closed {
		p.open--
		return c
	}
	for len(p.waiters) > 0 {
		w := p.waiters[0]
		p.waiters = p.waiters[1:]
		if w.settled {
			continue // 已超时的等待者，跳过
		}
		w.settled = true
		w.ch <- dialResult{conn: c}
		return nil
	}
	p.idle = append(p.idle, c)
	return nil
}
