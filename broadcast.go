// Package broadcast implements a bounded multi-subscriber broadcast buffer.
//
// A Broadcast retains at most N messages in a ring buffer. Every Subscriber
// has an independent cursor into the shared sequence. When the buffer is
// full and the oldest message is still needed by a slow subscriber, Publish blocks
// (backpressure) until that subscriber reads or unsubscribes. Unsubscribe
// removes the subscriber from the blocking set immediately. After Close,
// existing subscribers can still drain all already-published messages; new
// publishes fail with ErrClosed.
package broadcast

import (
	"errors"
	"sync"
)

var (
	// ErrClosed is returned by Publish after Close, and by Read once a
	// subscriber has drained every message published before Close.
	ErrClosed = errors.New("broadcast: closed")
	// ErrLagged is returned by Read if a subscriber's cursor fell behind
	// the retained window. Backpressure prevents this for subscribed
	// readers; it can only occur if a subscriber keeps reading after
	// Unsubscribe.
	ErrLagged = errors.New("broadcast: subscriber lagged behind")
)

// Message is a single broadcast entry with a monotonically increasing
// sequence number starting at 0.
type Message struct {
	Seq  uint64
	Data any
}

// Broadcast is a bounded ring buffer fanning messages out to subscribers.
type Broadcast struct {
	mu     sync.Mutex
	cond   *sync.Cond
	buf    []Message
	head   uint64 // sequence number of buf's oldest retained message
	count  int    // number of retained messages
	subs   map[*Subscriber]struct{}
	closed bool
}

// New returns a Broadcast retaining at most capacity messages.
func New(capacity int) *Broadcast {
	if capacity <= 0 {
		panic("broadcast: capacity must be positive")
	}
	b := &Broadcast{
		buf:  make([]Message, capacity),
		subs: make(map[*Subscriber]struct{}),
	}
	b.cond = sync.NewCond(&b.mu)
	return b
}

// Publish appends v and returns its sequence number. If the buffer is full
// and the oldest message is still unread by at least one subscriber, Publish
// blocks until that message is consumed or the subscriber unsubscribes.
// Publish returns ErrClosed after Close.
func (b *Broadcast) Publish(v any) (uint64, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for !b.closed && b.full() && b.oldestNeededLocked() {
		b.cond.Wait()
	}
	if b.closed {
		return 0, ErrClosed
	}
	if b.full() {
		// No subscriber needs the oldest message: overwrite it.
		b.head++
		b.count--
	}
	seq := b.head + uint64(b.count)
	b.buf[seq%uint64(cap(b.buf))] = Message{Seq: seq, Data: v}
	b.count++
	b.cond.Broadcast()
	return seq, nil
}

// Subscribe returns a new Subscriber whose cursor starts at the next message
// to be published.
func (b *Broadcast) Subscribe() *Subscriber {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := &Subscriber{b: b, next: b.head + uint64(b.count)}
	b.subs[s] = struct{}{}
	return s
}

// Close shuts the broadcast down. Blocked and future Publish calls fail with
// ErrClosed. Subscribers may still Read every message published before Close;
// Read returns ErrClosed once the buffer is drained.
func (b *Broadcast) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	b.cond.Broadcast()
}

func (b *Broadcast) full() bool { return b.count == cap(b.buf) }

// oldestNeededLocked reports whether any subscriber still needs the oldest
// retained message.
func (b *Broadcast) oldestNeededLocked() bool {
	for s := range b.subs {
		if s.next <= b.head {
			return true
		}
	}
	return false
}

// Subscriber reads the broadcast stream from its own cursor.
type Subscriber struct {
	b    *Broadcast
	next uint64
}

// Read blocks until the next message is available and returns it. It returns
// ErrClosed once Close has been called and all published messages have been
// drained, and ErrLagged if the cursor fell behind the retained window.
func (s *Subscriber) Read() (Message, error) {
	b := s.b
	b.mu.Lock()
	defer b.mu.Unlock()
	for {
		if s.next < b.head {
			return Message{}, ErrLagged
		}
		if s.next < b.head+uint64(b.count) {
			m := b.buf[s.next%uint64(cap(b.buf))]
			s.next++
			b.cond.Broadcast() // a blocked publisher may proceed now
			return m, nil
		}
		if b.closed {
			return Message{}, ErrClosed
		}
		b.cond.Wait()
	}
}

// Unsubscribe removes the subscriber from the set that blocks Publish. It
// takes effect immediately and is safe to call multiple times.
func (s *Subscriber) Unsubscribe() {
	b := s.b
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.subs, s)
	b.cond.Broadcast()
}
