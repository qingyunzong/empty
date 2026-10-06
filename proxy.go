// Package proxy 实现多跳异步转发代理：一次请求依次经过若干跳，
// 每跳持有独立的取消句柄；调用方取消或中途失败时，等待全部已开跳
// 关闭并汇总关闭错误；仅当末跳返回完整响应时才视为成功。
package proxy

import (
	"context"
	"errors"
	"sync"
)

// Request 是在各跳之间转发的工作单元。
type Request struct {
	ID      string
	Payload []byte
}

// Response 是单跳产出；只有末跳的完整响应（Complete=true）会返回给调用方。
type Response struct {
	Hop      string
	Payload  []byte
	Complete bool
}

// Result 是单跳的异步结果。
type Result struct {
	Resp Response
	Err  error
}

// Handle 是每跳独立的取消句柄。Close 取消该跳并阻塞至该跳资源完全释放。
type Handle interface {
	Result() <-chan Result
	Close() error
}

// Hop 是转发链中的一跳。
type Hop interface {
	Name() string
	Forward(ctx context.Context, req Request) (Handle, error)
}

// Proxy 将一次请求经多跳异步转发。
type Proxy struct {
	hops []Hop
}

// New 构造代理，至少要求一跳。
func New(hops ...Hop) (*Proxy, error) {
	if len(hops) == 0 {
		return nil, errors.New("proxy: at least one hop required")
	}
	return &Proxy{hops: hops}, nil
}

// Forward 异步执行整条转发链。
//
// 成功时仅返回末跳的完整响应；中途任一跳失败或调用方取消时，
// 逆序关闭全部已开跳并等待关闭完成，关闭失败经 errors.Join 汇总后
// 与主错误一并返回。结算由受控 Promise 完成，迟到完成被安全忽略。
func (p *Proxy) Forward(ctx context.Context, req Request) (Response, error) {
	promise := NewPromise[Response]()

	var mu sync.Mutex
	var opened []Handle
	track := func(h Handle) {
		mu.Lock()
		opened = append(opened, h)
		mu.Unlock()
	}
	closeAll := func() error {
		mu.Lock()
		handles := make([]Handle, len(opened))
		copy(handles, opened)
		mu.Unlock()
		var errs []error
		for i := len(handles) - 1; i >= 0; i-- {
			if err := handles[i].Close(); err != nil {
				errs = append(errs, err)
			}
		}
		return errors.Join(errs...)
	}

	chainDone := make(chan struct{})
	go func() {
		defer close(chainDone)
		current := req
		for i, hop := range p.hops {
			h, err := hop.Forward(ctx, current)
			if err != nil {
				promise.Reject(err)
				return
			}
			track(h)
			select {
			case <-ctx.Done():
				promise.Reject(ctx.Err())
				return
			case r, ok := <-h.Result():
				if !ok {
					promise.Reject(errors.New("proxy: hop " + hop.Name() + " closed without result"))
					return
				}
				if r.Err != nil {
					promise.Reject(r.Err)
					return
				}
				if i == len(p.hops)-1 {
					if !r.Resp.Complete {
						promise.Reject(errors.New("proxy: final hop response incomplete"))
						return
					}
					promise.Resolve(r.Resp)
					return
				}
				current = Request{ID: req.ID, Payload: r.Resp.Payload}
			}
		}
	}()

	resp, err := promise.Wait()
	closeErr := closeAll()
	<-chainDone
	if err != nil {
		return Response{}, errors.Join(err, closeErr)
	}
	return resp, closeErr
}
