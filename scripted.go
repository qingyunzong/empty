package resub

import (
	"context"
	"fmt"
	"io"
	"sync"
)

// ConnectRecord describes one Connect call: the resume point and generation.
type ConnectRecord struct {
	From uint64
	Gen  uint64
}

// ScriptedTransport is a controlled in-memory Transport for tests and
// simulations. It serves a fixed event list, resumes each new connection
// from the requested sequence number, fences stale generations, and supports
// deterministic fault injection.
type ScriptedTransport struct {
	events []Event

	// DropEvery drops each connection after that many deliveries, observed
	// on the following Recv. Zero disables the fault.
	DropEvery int
	// OnDeliver runs after each delivery; it may call conn.Drop to simulate
	// a disconnect between delivery and confirmation.
	OnDeliver func(c *ScriptedConn, ev Event)

	mu       sync.Mutex
	connects []ConnectRecord
	conns    []*ScriptedConn
}

// NewScriptedTransport returns a transport serving the given events in order.
func NewScriptedTransport(events []Event) *ScriptedTransport {
	return &ScriptedTransport{events: events}
}

// Events builds n synthetic events with stable IDs r-001..r-n.
func Events(n int) []Event {
	evs := make([]Event, n)
	for i := range evs {
		evs[i] = Event{
			Seq:     uint64(i + 1),
			ID:      fmt.Sprintf("r-%03d", i+1),
			Payload: []byte(fmt.Sprintf("payload-%d", i+1)),
		}
	}
	return evs
}

// Connect resumes the stream after from. Opening a new generation fences all
// previous connections: their Recv fails with ErrStaleGeneration.
func (t *ScriptedTransport) Connect(ctx context.Context, from uint64, gen uint64) (Conn, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	t.mu.Lock()
	for _, c := range t.conns {
		c.fence()
	}
	c := &ScriptedConn{tr: t, gen: gen, pos: int(from)}
	t.conns = append(t.conns, c)
	t.connects = append(t.connects, ConnectRecord{From: from, Gen: gen})
	t.mu.Unlock()
	return c, nil
}

// Connects returns the log of Connect calls in order.
func (t *ScriptedTransport) Connects() []ConnectRecord {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]ConnectRecord, len(t.connects))
	copy(out, t.connects)
	return out
}

// Conns returns all connections ever opened, oldest first.
func (t *ScriptedTransport) Conns() []*ScriptedConn {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]*ScriptedConn, len(t.conns))
	copy(out, t.conns)
	return out
}

// DropCurrent drops the most recently opened connection, simulating a
// disconnect between delivery and confirmation.
func (t *ScriptedTransport) DropCurrent() {
	t.mu.Lock()
	if len(t.conns) == 0 {
		t.mu.Unlock()
		return
	}
	c := t.conns[len(t.conns)-1]
	t.mu.Unlock()
	c.Drop()
}

// ScriptedConn is one generation of a scripted connection.
type ScriptedConn struct {
	tr  *ScriptedTransport
	gen uint64

	mu        sync.Mutex
	pos       int
	delivered int
	dropped   bool
	closed    bool
	stale     bool
}

// Drop marks the connection lost; subsequent Recv calls fail and Alive
// reports false.
func (c *ScriptedConn) Drop() {
	c.mu.Lock()
	c.dropped = true
	c.mu.Unlock()
}

func (c *ScriptedConn) fence() {
	c.mu.Lock()
	c.stale = true
	c.mu.Unlock()
}

// Alive reports whether the connection is still usable.
func (c *ScriptedConn) Alive() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.dropped && !c.closed && !c.stale
}

// Delivered returns how many events this connection delivered.
func (c *ScriptedConn) Delivered() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.delivered
}

// Gen returns the connection's generation.
func (c *ScriptedConn) Gen() uint64 { return c.gen }

func (c *ScriptedConn) Recv(ctx context.Context) (Event, error) {
	if err := ctx.Err(); err != nil {
		return Event{}, err
	}
	c.mu.Lock()
	if c.stale {
		c.mu.Unlock()
		return Event{}, ErrStaleGeneration
	}
	if c.closed || c.dropped {
		c.mu.Unlock()
		return Event{}, ErrDisconnected
	}
	if c.tr.DropEvery > 0 && c.delivered >= c.tr.DropEvery {
		c.mu.Unlock()
		return Event{}, ErrDisconnected
	}
	if c.pos >= len(c.tr.events) {
		c.mu.Unlock()
		return Event{}, io.EOF
	}
	ev := c.tr.events[c.pos]
	c.pos++
	c.delivered++
	hook := c.tr.OnDeliver
	c.mu.Unlock()
	if hook != nil {
		hook(c, ev)
	}
	return ev, nil
}

func (c *ScriptedConn) Close() error {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	return nil
}
