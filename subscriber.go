package resub

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

// errRedeliver is internal: the callback rejected an event, so it stays
// unconfirmed and will be redelivered on the next generation.
var errRedeliver = errors.New("resub: callback failed, event will be redelivered")

// Options tunes a Subscriber.
type Options struct {
	// RetryDelay is the delay before reconnecting after a failure.
	// Non-positive values use a small default.
	RetryDelay time.Duration
	// PreConfirm runs after the callback succeeds and before the event is
	// confirmed. It is a test hook used to inject faults between delivery
	// and confirmation.
	PreConfirm func(ev Event)
}

// liveness is implemented by connections that can report whether they are
// still usable, letting the subscriber avoid confirming on a dead connection.
type liveness interface {
	Alive() bool
}

// Subscriber consumes events from a Transport, confirms them in a Ledger and
// reconnects from the last confirmed sequence number after any failure.
//
// Semantics:
//   - an event is confirmed only after its callback succeeds;
//   - callback failure leaves the event unconfirmed, so it is redelivered
//     (with its stable result ID) on the next generation;
//   - every reconnect starts a new generation, which cancels the previous
//     connection;
//   - the confirmation ledger never skips or repeats a sequence number.
type Subscriber struct {
	transport Transport
	cb        Callback
	opts      Options
	ledger    *Ledger

	mu     sync.Mutex
	gen    uint64
	cancel context.CancelFunc
}

// NewSubscriber builds a Subscriber. opts may be nil.
func NewSubscriber(t Transport, cb Callback, opts *Options) *Subscriber {
	s := &Subscriber{transport: t, cb: cb, ledger: &Ledger{}}
	if opts != nil {
		s.opts = *opts
	}
	return s
}

// Ledger returns the confirmation ledger.
func (s *Subscriber) Ledger() *Ledger { return s.ledger }

// Generation returns the current connection generation.
func (s *Subscriber) Generation() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.gen
}

// Run consumes until the stream ends (io.EOF), the context is cancelled, or a
// fatal protocol violation (sequence gap) occurs.
func (s *Subscriber) Run(ctx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		// A new generation cancels the previous connection.
		s.mu.Lock()
		if s.cancel != nil {
			s.cancel()
		}
		s.gen++
		gen := s.gen
		connCtx, cancel := context.WithCancel(ctx)
		s.cancel = cancel
		from := s.ledger.Last()
		s.mu.Unlock()

		conn, err := s.transport.Connect(ctx, from, gen)
		if err != nil {
			cancel()
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if !s.sleep(ctx) {
				return ctx.Err()
			}
			continue
		}
		err = s.consume(connCtx, conn, gen)
		cancel()
		_ = conn.Close()
		switch {
		case err == nil, errors.Is(err, io.EOF):
			return nil
		case errors.Is(err, errRedeliver),
			errors.Is(err, ErrDisconnected),
			errors.Is(err, ErrStaleGeneration):
			if !s.sleep(ctx) {
				return ctx.Err()
			}
		case ctx.Err() != nil:
			return ctx.Err()
		default:
			return err
		}
	}
}

func (s *Subscriber) consume(ctx context.Context, conn Conn, gen uint64) error {
	for {
		ev, err := conn.Recv(ctx)
		if err != nil {
			return err
		}
		last := s.ledger.Last()
		switch {
		case ev.Seq <= last:
			// Duplicate of an already confirmed event: the stable ID
			// makes it safe to skip without touching the ledger.
			continue
		case ev.Seq != last+1:
			return fmt.Errorf("resub: sequence gap: confirmed up to %d, received %d", last, ev.Seq)
		}
		if err := s.cb(ctx, ev); err != nil {
			return errRedeliver
		}
		if s.opts.PreConfirm != nil {
			s.opts.PreConfirm(ev)
		}
		if !s.current(gen) {
			return ErrStaleGeneration
		}
		if a, ok := conn.(liveness); ok && !a.Alive() {
			// Lost between delivery and confirmation: leave the event
			// unconfirmed so it is redelivered on the next generation.
			return ErrDisconnected
		}
		s.ledger.append(Ack{Seq: ev.Seq, ID: ev.ID, Gen: gen})
	}
}

func (s *Subscriber) current(gen uint64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.gen == gen
}

func (s *Subscriber) sleep(ctx context.Context) bool {
	d := s.opts.RetryDelay
	if d <= 0 {
		d = 5 * time.Millisecond
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
