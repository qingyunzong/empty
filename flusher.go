// Package groupflush 提供"组提交"式刷盘：多个并发调用共享同一次 fsync。
//
// 核心语义：
//   - 批次在写入前封口：后台刷盘协程一旦取走当前批次，该批即封口，
//     后续 Append 只能进入下一批。
//   - 后来追加不能借旧 fsync 提前确认：新批次的数据在上一批 Sync
//     返回之后才写入，因此绝不会被上一批的 fsync 确认。
//   - 一次同步失败只影响该批（以及更早仍未确认者，本实现为串行刷盘，
//     不存在更早未确认批次），后续新批次不受影响，允许继续重试。
//   - 取消独立：单个调用方取消 context 只影响它自己的返回值，
//     不会取消共享的 fsync，也不影响同批其他调用方。
package groupflush

import (
	"context"
	"errors"
	"sync"
)

// ErrClosed 是 Flusher 关闭后 Append/Close 返回的错误。
var ErrClosed = errors.New("groupflush: flusher 已关闭")

// Filer 是 Flusher 所需的最小持久化 sink。
// Write 追加写入，Sync 将此前所有写入落盘。
type Filer interface {
	Write(p []byte) (int, error)
	Sync() error
}

// request 是一次待确认的追加。
type request struct {
	data []byte
	done chan error // 缓冲为 1：调用方取消后，补发结果不会阻塞刷盘协程
}

// Flusher 串行地成批刷盘，同批共享一次 Sync。
type Flusher struct {
	f Filer

	mu     sync.Mutex
	cur    []*request // 当前未封口批次；nil 表示没有待刷请求
	closed bool

	wake chan struct{} // 每创建一个批次送入一个信号
	done chan struct{} // 刷盘协程退出时关闭
}

// New 返回一个围绕 f 的 Flusher，并启动后台刷盘协程。
func New(f Filer) *Flusher {
	fl := &Flusher{
		f:    f,
		wake: make(chan struct{}, 1),
		done: make(chan struct{}),
	}
	go fl.run()
	return fl
}

// Append 将 p 追加到当前未封口批次，并阻塞到该批落盘（或 ctx 取消）。
//
// ctx 取消只让本调用提前返回 ctx.Err()；数据仍会被写入并随批次刷盘，
// 同批其他调用方不受影响。返回 nil 表示 p 已随某次 Sync 落盘。
func (fl *Flusher) Append(ctx context.Context, p []byte) error {
	r := &request{data: p, done: make(chan error, 1)}

	fl.mu.Lock()
	if fl.closed {
		fl.mu.Unlock()
		return ErrClosed
	}
	if fl.cur == nil {
		fl.cur = make([]*request, 0, 8)
		// 不变量：一个批次只在创建时送一个信号；wake 缓冲为 1，
		// 且任一时刻至多一个未封口批次，因此这里不会阻塞。
		fl.wake <- struct{}{}
	}
	fl.cur = append(fl.cur, r)
	fl.mu.Unlock()

	select {
	case err := <-r.done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close 停止接受新追加，把已封口的剩余批次刷完后退出后台协程。
func (fl *Flusher) Close() error {
	fl.mu.Lock()
	if fl.closed {
		fl.mu.Unlock()
		return ErrClosed
	}
	fl.closed = true
	close(fl.wake)
	fl.mu.Unlock()
	<-fl.done
	return nil
}

// run 是后台刷盘协程：每收到一个信号就把当前批次封口、写入并 Sync 一次。
func (fl *Flusher) run() {
	defer close(fl.done)
	for range fl.wake {
		fl.mu.Lock()
		batch := fl.cur
		fl.cur = nil // 封口：此后的 Append 进入新批次
		fl.mu.Unlock()

		if len(batch) == 0 {
			continue
		}
		err := fl.flush(batch)
		for _, r := range batch {
			r.done <- err
		}
	}
}

// flush 先写完批次内全部数据，再做一次共享的 Sync。
// 任一步失败，整个批次都以该错误收场。
func (fl *Flusher) flush(batch []*request) error {
	for _, r := range batch {
		if _, err := fl.f.Write(r.data); err != nil {
			return err
		}
	}
	return fl.f.Sync()
}
