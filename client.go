package formal

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// Client is the business-facing lock API.
//
// One Client owns one leased session. Acquire blocks until the request reaches
// the head of the FIFO queue and is granted. Acquisitions by the same client
// for an already-held lock are reentrant: they succeed immediately, keep the
// same fencing token, and increment the recursion depth.
//
// A transport that detects a lost connection must call Deliver with an
// EventSessionLost. After that, Acquire returns ErrDisconnected until
// Reconnect succeeds.
type Client struct {
	backend Backend
	ttl     time.Duration

	connectMu sync.Mutex

	mu          sync.Mutex
	session     SessionID
	connected   bool
	closed      bool
	nextRequest RequestID
	waiters     map[RequestID]*waiter
	held        map[string]*heldState
	gates       map[string]chan struct{}
	lastErr     error
}

type waiterStatus uint8

const (
	waitPending waiterStatus = iota
	waitGranted
	waitLost
	waitCanceled
)

type waiter struct {
	status waiterStatus
	result chan acquireResult
}

type acquireResult struct {
	token Token
	err   error
}

// NewClient opens a new session with the given lease TTL.
func NewClient(backend Backend, ttl time.Duration) (*Client, error) {
	if backend == nil {
		return nil, fmt.Errorf("formal: nil backend")
	}
	if ttl <= 0 {
		return nil, ErrInvalidTTL
	}
	c := &Client{
		backend: backend,
		ttl:     ttl,
		waiters: make(map[RequestID]*waiter),
		held:    make(map[string]*heldState),
		gates:   make(map[string]chan struct{}),
		lastErr: ErrDisconnected,
	}
	if err := c.connect(); err != nil {
		return nil, err
	}
	return c, nil
}

// Session returns the current session id, or zero after Close.
func (c *Client) Session() SessionID {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.session
}

// Connected reports whether the client currently has a live session.
func (c *Client) Connected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connected && !c.closed
}

// LastError returns the reason the most recent session ended.
func (c *Client) LastError() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastErr
}

// Reconnect opens a new session after the previous one was lost.
func (c *Client) Reconnect() error {
	c.connectMu.Lock()
	defer c.connectMu.Unlock()

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return ErrClosed
	}
	if c.connected {
		c.mu.Unlock()
		return ErrAlreadyConnected
	}
	c.mu.Unlock()

	session, err := c.backend.OpenSession(c.ttl, c.Deliver)
	if err != nil {
		return err
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		_ = c.backend.CloseSession(session)
		return ErrClosed
	}
	if c.connected {
		_ = c.backend.CloseSession(session)
		return ErrAlreadyConnected
	}
	c.session = session
	c.connected = true
	c.lastErr = nil
	return nil
}

// connect is only used by NewClient, where the client starts disconnected.
func (c *Client) connect() error {
	c.connectMu.Lock()
	defer c.connectMu.Unlock()

	session, err := c.backend.OpenSession(c.ttl, c.Deliver)
	if err != nil {
		return err
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		_ = c.backend.CloseSession(session)
		return ErrClosed
	}
	c.session = session
	c.connected = true
	c.lastErr = nil
	return nil
}

// KeepAlive renews the session lease. Business code should call this
// comfortably before the TTL elapses, or run KeepAliveLoop.
func (c *Client) KeepAlive() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return ErrClosed
	}
	if !c.connected {
		c.mu.Unlock()
		return ErrDisconnected
	}
	session := c.session
	c.mu.Unlock()

	err := c.backend.KeepAlive(session)
	if errors.Is(err, ErrSessionLost) || errors.Is(err, ErrClosed) {
		c.failSession(session, err)
	}
	return err
}

// KeepAliveLoop renews the lease at each interval until ctx is canceled or the
// session is lost. It does not reconnect automatically.
func (c *Client) KeepAliveLoop(ctx context.Context, interval time.Duration) error {
	if interval <= 0 {
		return ErrInvalidTTL
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := c.KeepAlive(); err != nil {
				return err
			}
		}
	}
}

// Acquire waits until the client owns lock. If the client already owns lock,
// Acquire returns a nested handle immediately with the same token. If a grant
// races with context cancellation, the grant wins and the caller owns the
// returned handle.
func (c *Client) Acquire(ctx context.Context, lock string) (*Handle, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if lock == "" {
		return nil, ErrInvalidLock
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, ErrClosed
	}
	if !c.connected {
		c.mu.Unlock()
		return nil, ErrDisconnected
	}
	if h := c.held[lock]; h != nil {
		h.depth++
		handle := &Handle{
			client:  c,
			lock:    lock,
			token:   h.token,
			session: c.session,
		}
		c.mu.Unlock()
		return handle, nil
	}
	gate := c.gates[lock]
	if gate == nil {
		gate = make(chan struct{}, 1)
		c.gates[lock] = gate
	}
	c.mu.Unlock()

	// Serialize same-client acquisitions for one lock. Without this, two
	// concurrent Acquire calls could both reach the service while the lock is
	// not yet held; one would be granted and the other queued, even though the
	// session now owns the lock.
	select {
	case gate <- struct{}{}:
		defer func() { <-gate }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, ErrClosed
	}
	if !c.connected {
		c.mu.Unlock()
		return nil, ErrDisconnected
	}
	if h := c.held[lock]; h != nil {
		h.depth++
		handle := &Handle{
			client:  c,
			lock:    lock,
			token:   h.token,
			session: c.session,
		}
		c.mu.Unlock()
		return handle, nil
	}
	c.nextRequest++
	request := c.nextRequest
	w := &waiter{
		status: waitPending,
		result: make(chan acquireResult, 1),
	}
	c.waiters[request] = w
	session := c.session
	c.mu.Unlock()

	if _, err := c.backend.Acquire(session, request, lock); err != nil {
		c.mu.Lock()
		if c.waiters[request] == w {
			delete(c.waiters, request)
			w.status = waitLost
		}
		c.mu.Unlock()
		if errors.Is(err, ErrSessionLost) || errors.Is(err, ErrClosed) {
			c.failSession(session, err)
		}
		return nil, err
	}

	select {
	case result := <-w.result:
		return c.finishAcquire(request, w, result, lock, session)
	case <-ctx.Done():
		return c.abortAcquire(request, w, ctx, lock, session)
	}
}

func (c *Client) finishAcquire(
	request RequestID,
	w *waiter,
	result acquireResult,
	lock string,
	session SessionID,
) (*Handle, error) {
	c.mu.Lock()
	if c.waiters[request] == w {
		delete(c.waiters, request)
	}

	if result.err != nil {
		c.mu.Unlock()
		return nil, result.err
	}
	if c.closed {
		c.mu.Unlock()
		return nil, ErrClosed
	}
	if !c.connected || c.session != session {
		err := c.lostErrorLocked()
		c.mu.Unlock()
		return nil, err
	}
	h := c.held[lock]
	if h == nil || h.token != result.token {
		c.mu.Unlock()
		return nil, ErrLockLost
	}
	w.status = waitGranted
	c.mu.Unlock()

	return &Handle{
		client:  c,
		lock:    lock,
		token:   result.token,
		session: session,
	}, nil
}

func (c *Client) abortAcquire(
	request RequestID,
	w *waiter,
	ctx context.Context,
	lock string,
	session SessionID,
) (*Handle, error) {
	c.mu.Lock()
	if c.waiters[request] == w && w.status == waitPending {
		w.status = waitCanceled
		c.mu.Unlock()

		// Cancel closes the grant/cancel race on the service side. If the
		// grant won, the service releases it before returning.
		cancelErr := c.backend.Cancel(session, request)
		if errors.Is(cancelErr, ErrSessionLost) || errors.Is(cancelErr, ErrClosed) {
			c.failSession(session, cancelErr)
		}

		c.mu.Lock()
		if c.waiters[request] == w {
			delete(c.waiters, request)
		}
		c.mu.Unlock()
		return nil, ctx.Err()
	}
	c.mu.Unlock()

	// A grant or loss notification already won the race and is buffered.
	select {
	case result := <-w.result:
		return c.finishAcquire(request, w, result, lock, session)
	default:
	}

	c.mu.Lock()
	if c.waiters[request] == w {
		delete(c.waiters, request)
	}
	err := c.lostErrorLocked()
	if !errors.Is(err, ErrSessionLost) {
		err = ctx.Err()
	}
	c.mu.Unlock()
	return nil, err
}

// Deliver is the transport entry point for service notifications. It is safe
// to call more than once for the same Event, concurrently, and after the
// session has ended; stale deliveries are ignored.
func (c *Client) Deliver(event Event) {
	c.mu.Lock()
	if c.closed || c.session != event.Session {
		c.mu.Unlock()
		return
	}

	switch event.Type {
	case EventGranted:
		if !c.connected {
			c.mu.Unlock()
			return
		}
		w := c.waiters[event.Request]
		if w == nil || w.status != waitPending {
			c.mu.Unlock()
			return
		}

		h := c.held[event.Lock]
		if h == nil {
			c.held[event.Lock] = &heldState{token: event.Token, depth: 1}
		} else if h.token == event.Token {
			// Two concurrent Acquire calls can both reach the service
			// before the first grant is processed. The service answers the
			// second as a reentrant grant; count it exactly once per waiter.
			h.depth++
		} else {
			w.status = waitLost
			delete(c.waiters, event.Request)
			w.result <- acquireResult{err: ErrLockLost}
			c.mu.Unlock()
			return
		}

		w.status = waitGranted
		w.result <- acquireResult{token: event.Token}

	case EventRevoked:
		if h := c.held[event.Lock]; h != nil && event.Token != 0 && h.token == event.Token {
			delete(c.held, event.Lock)
		}

	case EventSessionLost:
		if !c.connected {
			c.mu.Unlock()
			return
		}
		c.connected = false
		c.lastErr = event.Err
		if c.lastErr == nil {
			c.lastErr = ErrSessionLost
		}
		c.held = make(map[string]*heldState)
		for request, w := range c.waiters {
			if w.status == waitPending {
				w.status = waitLost
				w.result <- acquireResult{err: c.lastErr}
			}
			delete(c.waiters, request)
		}
	}
	c.mu.Unlock()
}

// Close ends the session and revokes any locks held by it. It is idempotent.
func (c *Client) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	c.connected = false
	session := c.session
	c.session = 0
	c.lastErr = ErrClosed
	c.held = make(map[string]*heldState)
	for request, w := range c.waiters {
		if w.status == waitPending {
			w.status = waitLost
			w.result <- acquireResult{err: ErrClosed}
		}
		delete(c.waiters, request)
	}
	c.mu.Unlock()

	if session != 0 {
		return c.backend.CloseSession(session)
	}
	return nil
}

func (c *Client) failSession(session SessionID, reason error) {
	if reason == nil {
		reason = ErrSessionLost
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || !c.connected || c.session != session {
		return
	}
	c.connected = false
	c.lastErr = reason
	c.held = make(map[string]*heldState)
	for request, w := range c.waiters {
		if w.status == waitPending {
			w.status = waitLost
			w.result <- acquireResult{err: reason}
		}
		delete(c.waiters, request)
	}
}

func (c *Client) lostErrorLocked() error {
	if c.lastErr != nil {
		return c.lastErr
	}
	return ErrDisconnected
}

func (c *Client) unlock(h *Handle) error {
	c.mu.Lock()
	if c.closed || !c.connected || c.session != h.session {
		c.mu.Unlock()
		return ErrLockLost
	}
	state := c.held[h.lock]
	if state == nil || state.token != h.token {
		c.mu.Unlock()
		return ErrLockLost
	}
	state.depth--
	if state.depth > 0 {
		c.mu.Unlock()
		return nil
	}
	delete(c.held, h.lock)
	session := c.session
	token := h.token
	c.mu.Unlock()

	err := c.backend.Release(session, h.lock, token)
	// The desired end state is already true for all of these: the lock is
	// either gone with the session or owned by somebody else.
	if errors.Is(err, ErrSessionLost) ||
		errors.Is(err, ErrNotHeld) ||
		errors.Is(err, ErrStaleToken) {
		return nil
	}
	return err
}

func (c *Client) valid(h *Handle) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || !c.connected || c.session != h.session {
		return false
	}
	state := c.held[h.lock]
	return state != nil && state.token == h.token
}

// Handle represents one acquisition level of a lock. Each successful Acquire
// returns a distinct Handle, even when the acquisition was reentrant. Every
// Handle must be released exactly once.
type Handle struct {
	client   *Client
	lock     string
	token    Token
	session  SessionID
	released atomic.Bool
}

// Token returns the fencing token associated with this ownership.
func (h *Handle) Token() Token {
	if h == nil {
		return 0
	}
	return h.token
}

// Lock returns the lock name.
func (h *Handle) Lock() string {
	if h == nil {
		return ""
	}
	return h.lock
}

// Valid reports whether this handle still represents live ownership.
func (h *Handle) Valid() bool {
	if h == nil || h.client == nil || h.released.Load() {
		return false
	}
	return h.client.valid(h)
}

// Unlock releases one recursion level. The lock is actually released only
// when the last nested handle is unlocked.
func (h *Handle) Unlock() error {
	if h == nil || h.client == nil {
		return ErrLockLost
	}
	if h.released.Swap(true) {
		return ErrHandleReleased
	}
	return h.client.unlock(h)
}
