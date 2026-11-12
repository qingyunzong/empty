package streamdl

import (
	"bytes"
	"io"
	"net"
	"sync"
	"time"
)

// bufferedPipe returns a pair of connected in-memory conns. Each side has its
// own lock and buffer so concurrent request/response traffic cannot deadlock.
// Wakes are delivered through a channel that is closed on shutdown, which lets
// a blocked Read (including net/http's background conn reader during Hijack)
// be interrupted asynchronously.
func bufferedPipe() (net.Conn, net.Conn) {
	a := &pipeConn{}
	b := &pipeConn{}
	a.wake = make(chan struct{})
	b.wake = make(chan struct{})
	a.peer, b.peer = b, a
	return a, b
}

type pipeConn struct {
	peer *pipeConn

	mu           sync.Mutex
	buf          bytes.Buffer
	readClosed   bool
	writeClosed  bool
	wake         chan struct{}
	wakeClosed   bool
	readDeadline time.Time
}

// signal wakes every current/ future waiter. Caller must hold c.mu.
func (c *pipeConn) signal() {
	if !c.wakeClosed {
		close(c.wake)
		c.wakeClosed = true
	}
}

// armWake installs a fresh wake channel after waiters have been released.
// Caller must hold c.mu.
func (c *pipeConn) armWake() {
	if c.wakeClosed && c.buf.Len() == 0 && !c.readClosed && !c.writeClosed {
		c.wake = make(chan struct{})
		c.wakeClosed = false
	}
}

func (c *pipeConn) Read(p []byte) (int, error) {
	c.mu.Lock()
	for c.buf.Len() == 0 {
		if c.readClosed {
			c.mu.Unlock()
			return 0, net.ErrClosed
		}
		if c.writeClosed {
			c.mu.Unlock()
			return 0, io.EOF
		}
		if !c.readDeadline.IsZero() && !time.Now().Before(c.readDeadline) {
			c.mu.Unlock()
			return 0, errDeadline
		}
		var timer *time.Timer
		if !c.readDeadline.IsZero() {
			d := time.Until(c.readDeadline)
			timer = time.AfterFunc(d, func() {
				c.mu.Lock()
				c.signal()
				c.mu.Unlock()
			})
		}
		wake := c.wake
		c.mu.Unlock()
		select {
		case <-wake:
		}
		if timer != nil {
			timer.Stop()
		}
		c.mu.Lock()
		c.armWake()
	}
	n, err := c.buf.Read(p)
	c.mu.Unlock()
	return n, err
}

func (c *pipeConn) Write(p []byte) (int, error) {
	peer := c.peer
	peer.mu.Lock()
	if peer.readClosed || peer.writeClosed {
		peer.mu.Unlock()
		return 0, io.EOF
	}
	n, err := peer.buf.Write(p)
	peer.signal()
	peer.mu.Unlock()
	return n, err
}

// CloseWrite half-closes: the peer drains buffered bytes, then gets EOF.
func (c *pipeConn) CloseWrite() error {
	peer := c.peer
	peer.mu.Lock()
	peer.writeClosed = true
	peer.signal()
	peer.mu.Unlock()
	return nil
}

// Close aborts local reads and half-closes the write side for the peer.
func (c *pipeConn) Close() error {
	c.mu.Lock()
	c.readClosed = true
	c.signal()
	c.mu.Unlock()
	return c.CloseWrite()
}

type pipeTimeoutError struct{}

func (pipeTimeoutError) Error() string   { return "streamdl test conn: i/o timeout" }
func (pipeTimeoutError) Timeout() bool   { return true }
func (pipeTimeoutError) Temporary() bool { return true }

var errDeadline net.Error = pipeTimeoutError{}

func (c *pipeConn) LocalAddr() net.Addr  { return pipeAddr{} }
func (c *pipeConn) RemoteAddr() net.Addr { return pipeAddr{} }

func (c *pipeConn) SetDeadline(t time.Time) error {
	if err := c.SetReadDeadline(t); err != nil {
		return err
	}
	return c.SetWriteDeadline(t)
}

func (c *pipeConn) SetReadDeadline(t time.Time) error {
	c.mu.Lock()
	c.readDeadline = t
	c.signal()
	c.mu.Unlock()
	return nil
}

func (c *pipeConn) SetWriteDeadline(_ time.Time) error { return nil }
