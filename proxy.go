package proxy

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// ErrHopClosed is delivered when a hop's result stream terminates without
// producing a result, e.g. because the hop was closed during cancellation.
var ErrHopClosed = errors.New("proxy: hop closed without a result")

// Request is the unit of work forwarded through the hop chain.
type Request struct {
	Body    []byte
	Headers map[string]string
}

// Response is the terminal reply of the final hop.
type Response struct {
	Status  int
	Body    []byte
	Headers map[string]string
}

// Result is the asynchronous outcome of a single hop.
type Result struct {
	Resp *Response
	Err  error
}

// HopHandle is the per-hop cancellation handle. Close must cancel the hop
// and, once it returns, the hop's result stream must terminate eventually.
type HopHandle interface {
	// Results yields exactly one terminal result, or is closed to signal
	// termination without a result.
	Results() <-chan Result
	// Close cancels this hop. It is safe to call once.
	Close() error
}

// Hop is one forwarding stage of the chain.
type Hop interface {
	Open(ctx context.Context, req *Request) (HopHandle, error)
}

// Proxy is a multi-hop asynchronous forwarder.
type Proxy struct {
	hops     []Hop
	onSettle func(hop int, s State)
}

// Option customizes a Proxy.
type Option func(*Proxy)

// WithSettleObserver registers a callback invoked for every settlement
// attempt of every hop, including LateCompleted arrivals after the proxy
// has already returned.
func WithSettleObserver(fn func(hop int, s State)) Option {
	return func(p *Proxy) { p.onSettle = fn }
}

// New builds a Proxy from at least one hop.
func New(hops []Hop, opts ...Option) (*Proxy, error) {
	if len(hops) == 0 {
		return nil, errors.New("proxy: at least one hop is required")
	}
	p := &Proxy{hops: hops}
	for _, o := range opts {
		o(p)
	}
	return p, nil
}

// Forward sends req through every hop in order and returns the complete
// response of the final hop. Intermediate hop results are consumed but
// discarded. If the caller's context is cancelled, or any hop fails, every
// hop opened so far is closed; Forward waits for all closes to finish and
// joins their errors with the primary failure.
func (p *Proxy) Forward(ctx context.Context, req *Request) (*Response, error) {
	var opened []HopHandle

	closeAll := func() error {
		var wg sync.WaitGroup
		errs := make([]error, len(opened))
		for i, h := range opened {
			wg.Add(1)
			go func(i int, h HopHandle) {
				defer wg.Done()
				errs[i] = h.Close()
			}(i, h)
		}
		wg.Wait()
		return errors.Join(errs...)
	}

	for i, hop := range p.hops {
		handle, err := hop.Open(ctx, req)
		if err != nil {
			return nil, errors.Join(
				fmt.Errorf("proxy: open hop %d: %w", i, err),
				closeAll(),
			)
		}
		opened = append(opened, handle)

		pr := NewPromise()
		go func(idx int, h HopHandle, pr *Promise) {
			res, ok := <-h.Results()
			var st State
			if !ok {
				st = pr.Settle(Result{Err: ErrHopClosed})
			} else {
				st = pr.Settle(res)
			}
			if p.onSettle != nil {
				p.onSettle(idx, st)
			}
		}(i, handle, pr)

		select {
		case <-pr.Done():
			res := pr.Result()
			if res.Err != nil {
				return nil, errors.Join(
					fmt.Errorf("proxy: hop %d failed: %w", i, res.Err),
					closeAll(),
				)
			}
			if i == len(p.hops)-1 {
				return res.Resp, nil
			}
		case <-ctx.Done():
			// Seal the pending hop so any result it delivers from now on
			// is enumerated as a late completion and discarded.
			pr.Settle(Result{Err: ctx.Err()})
			return nil, errors.Join(ctx.Err(), closeAll())
		}
	}
	// Unreachable: the final hop always returns above.
	return nil, errors.New("proxy: empty hop chain")
}
