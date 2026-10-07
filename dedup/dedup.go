// Package dedup merges concurrent subscriptions for the same key into a
// single upstream download. The upstream download is cancelled only when
// its last subscriber cancels; subscribers that join afterwards start a
// new generation instead of attaching to the cancelled one. When the
// upstream finishes, only still-active subscribers are notified.
//
// Every subscription reaches exactly one terminal state, delivered through
// its callback: the downloaded value, the upstream error, or ErrCancelled.
// Callbacks are never invoked while holding internal locks, so a callback
// may safely re-enter the Deduper (subscribe again, cancel, and so on).
package dedup

import (
	"context"
	"errors"
	"sync"
)

// ErrCancelled is the terminal result of a subscription that was cancelled
// before its generation completed.
var ErrCancelled = errors.New("dedup: subscription cancelled")

// Result is the terminal outcome of a subscription. Exactly one of Value
// or Err is meaningful: Value is set on success, Err otherwise.
type Result struct {
	Value any
	Err   error
}

// DownloadFunc performs the upstream download for a key. It must honor
// ctx cancellation: when the last subscriber of a generation cancels, ctx
// is cancelled and the download should abort.
type DownloadFunc func(ctx context.Context, key string) (any, error)

// Deduper deduplicates downloads by key. The zero value is not usable;
// construct one with New.
type Deduper struct {
	download DownloadFunc

	mu   sync.Mutex
	gens map[string]*generation // key -> live generation
}

// New returns a Deduper that runs upstream downloads with download.
func New(download DownloadFunc) *Deduper {
	return &Deduper{
		download: download,
		gens:     make(map[string]*generation),
	}
}

// generation is one shared upstream download for a key. A generation ends
// either when the download finishes or when its last subscriber cancels;
// it is then unlinked from the Deduper so later subscriptions start a
// fresh generation.
type generation struct {
	key    string
	ctx    context.Context
	cancel context.CancelFunc
	subs   map[*Subscription]struct{}
	done   bool // terminal: finished or cancelled, no new subscribers may join
}

// Subscription is a single subscriber's handle on a generation.
type Subscription struct {
	d   *Deduper
	gen *generation
	cb  func(Result)

	done     chan struct{} // closed exactly once, at the terminal state
	terminal bool          // guarded by d.mu
	result   Result        // guarded by d.mu; valid once done is closed
}

// Subscribe registers cb for key. If a live generation for key exists the
// subscription joins it and shares its upstream download; otherwise a new
// generation (and upstream download) is started. cb is invoked exactly
// once, after Subscribe returns, with the subscription's terminal result.
// A nil cb is allowed; the terminal state is still observable via Done
// and Result.
func (d *Deduper) Subscribe(key string, cb func(Result)) *Subscription {
	d.mu.Lock()
	gen := d.gens[key]
	if gen == nil {
		ctx, cancel := context.WithCancel(context.Background())
		gen = &generation{
			key:    key,
			ctx:    ctx,
			cancel: cancel,
			subs:   make(map[*Subscription]struct{}),
		}
		d.gens[key] = gen
		go d.run(gen)
	}
	sub := &Subscription{
		d:    d,
		gen:  gen,
		cb:   cb,
		done: make(chan struct{}),
	}
	gen.subs[sub] = struct{}{}
	d.mu.Unlock()
	return sub
}

// run executes the upstream download and settles the generation.
func (d *Deduper) run(gen *generation) {
	value, err := d.download(gen.ctx, gen.key)
	d.finish(gen, Result{Value: value, Err: err})
}

// finish terminates every still-active subscriber of gen with res and
// unlinks gen. Cancelled subscribers were already terminated with
// ErrCancelled and are not notified again.
func (d *Deduper) finish(gen *generation, res Result) {
	d.mu.Lock()
	if gen.done {
		// The generation was already cancelled by its last subscriber;
		// nobody active remains to notify.
		d.mu.Unlock()
		return
	}
	gen.done = true
	if d.gens[gen.key] == gen {
		delete(d.gens, gen.key)
	}
	subs := make([]*Subscription, 0, len(gen.subs))
	for sub := range gen.subs {
		sub.terminal = true
		sub.result = res
		close(sub.done)
		subs = append(subs, sub)
	}
	gen.subs = nil
	d.mu.Unlock()

	// Callbacks run outside the lock: they may re-enter the Deduper.
	for _, sub := range subs {
		if sub.cb != nil {
			sub.cb(res)
		}
	}
}

// Cancel terminates the subscription with ErrCancelled, unless it already
// reached a terminal state. When the cancelled subscription was the last
// active one of its generation, the generation's upstream download is
// cancelled and the generation is unlinked, so later subscriptions for
// the same key start a new generation. Cancel is idempotent.
func (s *Subscription) Cancel() {
	s.d.mu.Lock()
	if s.terminal {
		s.d.mu.Unlock()
		return
	}
	s.terminal = true
	s.result = Result{Err: ErrCancelled}
	close(s.done)

	gen := s.gen
	delete(gen.subs, s)
	if len(gen.subs) == 0 {
		// Last subscriber gone: cancel upstream and retire the generation
		// so a new subscription cannot join this cancelled generation.
		gen.done = true
		gen.cancel()
		if s.d.gens[gen.key] == gen {
			delete(s.d.gens, gen.key)
		}
	}
	s.d.mu.Unlock()

	if s.cb != nil {
		s.cb(s.result)
	}
}

// Done returns a channel closed when the subscription reaches its single
// terminal state.
func (s *Subscription) Done() <-chan struct{} {
	return s.done
}

// Result blocks until the subscription terminates and returns its
// terminal result.
func (s *Subscription) Result() Result {
	<-s.done
	return s.result
}
