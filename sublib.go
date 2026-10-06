// Package sublib implements a reconnecting subscription client with
// exactly-once acknowledgment semantics:
//
//   - After a disconnect it resumes from the last acknowledged sequence.
//   - The acknowledgment advances only after the handler succeeds.
//   - Failed deliveries may be redelivered; the ResultID stays stable so
//     the handler can deduplicate.
//   - Every reconnect opens a new generation that cancels the old connection.
//   - All acknowledgments are recorded in an inspectable Ledger.
package sublib

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Message is one delivered result from the subscription stream.
type Message struct {
	// Seq is the monotonically increasing stream position, starting at 1.
	Seq uint64
	// ResultID identifies the logical result. It is stable across
	// redeliveries of the same result.
	ResultID string
	// Payload is the opaque result body.
	Payload []byte
}

// Conn is one generation of the server connection. Close must be
// idempotent.
type Conn interface {
	// Recv returns the next message. It must unblock with an error when
	// ctx is cancelled or the connection drops.
	Recv(ctx context.Context) (Message, error)
	// Ack confirms receipt and processing of seq.
	Ack(ctx context.Context, seq uint64) error
	// Close releases the connection. Safe to call more than once.
	Close() error
}

// Transport dials the subscription server. fromSeq is the first sequence
// the client still needs, i.e. last acknowledged sequence + 1.
type Transport interface {
	Dial(ctx context.Context, fromSeq uint64) (Conn, error)
}

// Handler processes one delivered message. The acknowledgment for the
// message advances only if Handler returns nil. A non-nil return causes a
// reconnect and redelivery of the same result with a stable ResultID.
type Handler func(ctx context.Context, msg Message) error

// Client consumes a subscription stream with resume-from-last-ack
// semantics.
type Client struct {
	transport Transport
	handler   Handler
	backoff   func(attempt int) time.Duration

	ledger Ledger

	mu     sync.Mutex
	gen    uint64
	cancel context.CancelFunc // cancels the current generation
	conn   Conn               // current generation's connection
}

// Option configures a Client.
type Option func(*Client)

// WithBackoff sets the delay before reconnect attempt n (0-based).
// The default is a fixed 5ms delay.
func WithBackoff(f func(attempt int) time.Duration) Option {
	return func(c *Client) { c.backoff = f }
}

// NewClient builds a Client that consumes from t and delivers to h.
func NewClient(t Transport, h Handler, opts ...Option) *Client {
	c := &Client{transport: t, handler: h}
	for _, o := range opts {
		o(c)
	}
	return c
}

// Generation returns the current connection generation, incremented on
// every (re)connect.
func (c *Client) Generation() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gen
}

// Ledger returns a copy of the acknowledgment ledger.
func (c *Client) Ledger() []LedgerEntry { return c.ledger.Entries() }

// LedgerString renders the acknowledgment ledger.
func (c *Client) LedgerString() string { return c.ledger.String() }

// Reconnect cancels the current generation's connection, forcing Run to
// dial a fresh generation resuming from the last acknowledged sequence.
func (c *Client) Reconnect() {
	c.mu.Lock()
	cancel := c.cancel
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Run consumes the stream until ctx is cancelled. It always resumes from
// the last acknowledged sequence and returns ctx.Err() on shutdown.
func (c *Client) Run(ctx context.Context) error {
	attempt := 0
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		from := c.ledger.LastAck() + 1
		conn, err := c.transport.Dial(ctx, from)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			c.sleep(ctx, attempt)
			attempt++
			continue
		}
		genCtx := c.startGeneration(ctx, conn)
		c.consume(genCtx, conn)
		c.closeConn(conn)
		if err := ctx.Err(); err != nil {
			return err
		}
		c.sleep(ctx, attempt)
		attempt++
	}
}

// startGeneration opens a new generation: the previous generation's
// context is cancelled and its connection closed before the new one runs.
func (c *Client) startGeneration(parent context.Context, conn Conn) context.Context {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cancel != nil {
		c.cancel()
	}
	if c.conn != nil {
		c.conn.Close()
	}
	c.gen++
	ctx, cancel := context.WithCancel(parent)
	c.cancel = cancel
	c.conn = conn
	return ctx
}

func (c *Client) closeConn(conn Conn) {
	c.mu.Lock()
	if c.conn == conn {
		c.conn = nil
		c.cancel = nil
	}
	c.mu.Unlock()
	conn.Close()
}

// consume runs the delivery loop for one generation: handle, then ack,
// then record. Any error drops the connection so Run reconnects and the
// server redelivers from the last acknowledged sequence.
func (c *Client) consume(ctx context.Context, conn Conn) error {
	for {
		msg, err := conn.Recv(ctx)
		if err != nil {
			return err
		}
		if c.ledger.Acked(msg.Seq) {
			// Duplicate of an already-acked delivery: re-ack without
			// invoking the handler again.
			if err := conn.Ack(ctx, msg.Seq); err != nil {
				return err
			}
			continue
		}
		if err := c.handler(ctx, msg); err != nil {
			return fmt.Errorf("sublib: handler rejected seq %d (result %s): %w", msg.Seq, msg.ResultID, err)
		}
		if err := conn.Ack(ctx, msg.Seq); err != nil {
			return err
		}
		if err := c.ledger.Record(msg.Seq, msg.ResultID); err != nil {
			return err
		}
	}
}

func (c *Client) sleep(ctx context.Context, attempt int) {
	d := 5 * time.Millisecond
	if c.backoff != nil {
		d = c.backoff(attempt)
	}
	if d <= 0 {
		return
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
