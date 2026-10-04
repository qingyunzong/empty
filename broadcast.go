// Package broadcast implements a many-to-many broadcast broker.
//
// Every subscription owns a bounded buffer. When a subscription's buffer
// cannot hold an entire publish batch, only that subscription is evicted
// and its termination reason is set to ErrBufferFull. A publish batch is
// delivered to every surviving subscription or to none of them: partial
// broadcasts never happen. Close terminates all remaining subscriptions
// with ErrClosed. All state transitions are serialized by the broker
// mutex, so the messages observed on any subscription always form a
// contiguous prefix of the broker's accepted publish stream.
package broadcast

import (
	"errors"
	"sync"
	"sync/atomic"
)

var (
	// ErrClosed is returned by Publish and Subscribe after the broker is
	// closed, and terminates subscriptions that are still active at Close.
	ErrClosed = errors.New("broadcast: broker closed")
	// ErrBufferFull terminates a subscription whose buffer cannot hold a
	// full publish batch.
	ErrBufferFull = errors.New("broadcast: subscription buffer full")
	// ErrUnsubscribed terminates a subscription cancelled by its owner.
	ErrUnsubscribed = errors.New("broadcast: unsubscribed")
)

// Broker fans publish batches out to all live subscriptions.
type Broker[T any] struct {
	mu     sync.Mutex
	subs   map[*Subscription[T]]struct{}
	closed bool
}

// New returns an open broker.
func New[T any]() *Broker[T] {
	return &Broker[T]{subs: make(map[*Subscription[T]]struct{})}
}

// Subscribe registers a subscription with a bounded buffer of buf
// messages. It returns ErrClosed if the broker is already closed.
func (b *Broker[T]) Subscribe(buf int) (*Subscription[T], error) {
	if buf < 0 {
		buf = 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil, ErrClosed
	}
	s := &Subscription[T]{broker: b, ch: make(chan T, buf)}
	b.subs[s] = struct{}{}
	return s, nil
}

// Publish atomically delivers batch to every live subscription.
//
// Subscriptions without room for the whole batch are evicted with
// ErrBufferFull; every surviving subscription then receives the entire
// batch in order. Publish never delivers a batch to only some of the
// surviving subscriptions. It returns ErrClosed once the broker is
// closed, in which case nothing is delivered.
func (b *Broker[T]) Publish(batch ...T) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return ErrClosed
	}
	for s := range b.subs {
		if cap(s.ch)-len(s.ch) < len(batch) {
			s.terminate(ErrBufferFull)
			delete(b.subs, s)
		}
	}
	for s := range b.subs {
		for _, v := range batch {
			s.ch <- v
		}
	}
	return nil
}

// Close terminates every live subscription with ErrClosed and rejects
// all future Publish and Subscribe calls. It is safe to call repeatedly
// and concurrently with Publish.
func (b *Broker[T]) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	for s := range b.subs {
		s.terminate(ErrClosed)
		delete(b.subs, s)
	}
}

// Subscriptions reports how many subscriptions are currently live.
func (b *Broker[T]) Subscriptions() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}

// Subscription is a bounded receive handle attached to a Broker.
type Subscription[T any] struct {
	broker *Broker[T]
	ch     chan T
	reason atomic.Value // error, set exactly once before ch is closed
}

// C returns the receive channel. It is closed when the subscription
// terminates; Err then reports why.
func (s *Subscription[T]) C() <-chan T { return s.ch }

// Err reports the termination reason, or nil while the subscription is
// still active.
func (s *Subscription[T]) Err() error {
	if r := s.reason.Load(); r != nil {
		return r.(error)
	}
	return nil
}

// Unsubscribe detaches the subscription from its broker and terminates
// it with ErrUnsubscribed.
func (s *Subscription[T]) Unsubscribe() {
	s.broker.mu.Lock()
	defer s.broker.mu.Unlock()
	if _, ok := s.broker.subs[s]; ok {
		delete(s.broker.subs, s)
		s.terminate(ErrUnsubscribed)
	}
}

// terminate records the reason and closes the channel. Callers must hold
// the broker mutex; the reason store happens-before the channel close,
// so any receiver that observes the close can read Err.
func (s *Subscription[T]) terminate(reason error) {
	s.reason.Store(reason)
	close(s.ch)
}
