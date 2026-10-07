// Package broadcast implements a bounded multi-subscriber broadcast buffer.
//
// The Broadcaster retains at most N messages. Every Subscription has an
// independent cursor, so each subscriber reads every message published
// after it subscribed, exactly once and in order. When the buffer is full
// and the slowest active subscriber has not caught up, Send blocks
// (publisher backpressure) until space frees up or the lagging subscriber
// unsubscribes. Unsubscribe takes effect immediately and never blocks the
// publisher. After Close, Send fails but subscribers may drain all
// messages published before the close.
package broadcast

import (
	"errors"
	"sync"
)

// ErrClosed is returned by Send after Close, and by Next once the
// broadcaster is closed and all published messages have been drained,
// or when the subscription has been cancelled.
var ErrClosed = errors.New("broadcast: closed")

// Broadcaster is a bounded broadcast buffer safe for concurrent use.
type Broadcaster struct {
	mu     sync.Mutex
	cond   *sync.Cond
	buf    []any
	base   uint64 // sequence number of the oldest retained message
	next   uint64 // sequence number the next published message will get
	closed bool
	subs   map[*Subscription]struct{}
}

// New returns a Broadcaster retaining at most capacity messages.
func New(capacity int) *Broadcaster {
	if capacity <= 0 {
		panic("broadcast: capacity must be positive")
	}
	b := &Broadcaster{
		buf:  make([]any, capacity),
		subs: make(map[*Subscription]struct{}),
	}
	b.cond = sync.NewCond(&b.mu)
	return b
}

// minCursorLocked returns the smallest cursor among active subscribers.
// The second return value reports whether any subscriber exists.
func (b *Broadcaster) minCursorLocked() (uint64, bool) {
	var min uint64
	found := false
	for s := range b.subs {
		if !found || s.cursor < min {
			min = s.cursor
			found = true
		}
	}
	return min, found
}

// Send publishes msg to all current and future-until-overwritten
// subscribers. It blocks while the buffer is full and the slowest active
// subscriber would lose an unread message (backpressure). It returns
// ErrClosed once the broadcaster is closed.
func (b *Broadcaster) Send(msg any) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	for {
		if b.closed {
			return ErrClosed
		}
		if min, ok := b.minCursorLocked(); !ok || b.next-min < uint64(len(b.buf)) {
			break
		}
		b.cond.Wait()
	}
	b.buf[b.next%uint64(len(b.buf))] = msg
	b.next++
	if b.next-b.base > uint64(len(b.buf)) {
		b.base = b.next - uint64(len(b.buf))
	}
	b.cond.Broadcast()
	return nil
}

// Subscribe returns a Subscription whose cursor starts at the next
// message to be published.
func (b *Broadcaster) Subscribe() *Subscription {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := &Subscription{b: b, cursor: b.next, active: true}
	if !b.closed {
		b.subs[s] = struct{}{}
	} else {
		s.active = false
	}
	return s
}

// Close shuts the broadcaster down. Pending and future Send calls return
// ErrClosed. Subscribers keep draining messages published before Close;
// Next returns ErrClosed once a subscriber is fully drained.
func (b *Broadcaster) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	b.cond.Broadcast()
}

// Subscription is an independent read cursor into a Broadcaster.
type Subscription struct {
	b      *Broadcaster
	cursor uint64
	active bool
}

// Next blocks until the next message for this subscriber is available and
// returns it. It returns ErrClosed when the broadcaster is closed and the
// subscriber has drained every published message, or after Unsubscribe.
func (s *Subscription) Next() (any, error) {
	b := s.b
	b.mu.Lock()
	defer b.mu.Unlock()
	for {
		if !s.active {
			return nil, ErrClosed
		}
		if s.cursor < b.base {
			// Unreachable while subscribed: Send applies backpressure.
			// Defensive: skip lost messages rather than corrupt order.
			s.cursor = b.base
		}
		if s.cursor < b.next {
			msg := b.buf[s.cursor%uint64(len(b.buf))]
			s.cursor++
			b.cond.Broadcast() // a slow reader advanced; wake blocked Senders
			return msg, nil
		}
		if b.closed {
			return nil, ErrClosed
		}
		b.cond.Wait()
	}
}

// Unsubscribe cancels the subscription. The subscriber immediately stops
// exerting backpressure on the publisher, and any pending Next call on
// this subscription returns ErrClosed.
func (s *Subscription) Unsubscribe() {
	b := s.b
	b.mu.Lock()
	defer b.mu.Unlock()
	if s.active {
		s.active = false
		delete(b.subs, s)
	}
	b.cond.Broadcast()
}
