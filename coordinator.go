package formal

import (
	"math"
	"sync"
	"time"
)

// Coordinator is an in-memory reference implementation of Backend.
//
// It owns the authoritative lock state: session leases, FIFO queues, sequence
// numbers, and fencing tokens. Business code normally talks only to Client;
// Coordinator is exposed so tests can advance leases, drop connections, and
// inspect queue state without a network.
type Coordinator struct {
	mu sync.Mutex

	clock Clock

	nextSessionID uint64
	nextSequence  uint64
	nextToken     uint64

	sessions map[SessionID]*sessionState
	locks    map[string]*lockState
	closed   bool
}

type sessionState struct {
	id      SessionID
	ttl     time.Duration
	leaseTo time.Time

	alive      bool
	generation uint64
	timer      Timer
	notify     func(Event)

	// held is keyed by lock name. A lock can be held at recursion depth > 1.
	held map[string]*heldState

	// requests contains every request made by this session so that retries
	// with the same RequestID are idempotent.
	requests map[RequestID]*requestState
}

type heldState struct {
	token Token
	depth int
}

type requestStatus uint8

const (
	requestPending requestStatus = iota
	requestGranted
	requestCanceled
)

type requestState struct {
	id       RequestID
	sequence uint64
	lock     string
	session  *sessionState
	status   requestStatus
	token    Token
}

type lockState struct {
	name   string
	holder *sessionState
	token  Token
	depth  int

	// queue is ordered by the service-assigned sequence number. Canceled
	// entries are skipped lazily during promotion.
	queue []*requestState
}

type delivery struct {
	session *sessionState
	event   Event
}

// NewCoordinator returns an in-memory coordination service. A nil clock uses
// SystemClock.
func NewCoordinator(clock Clock) *Coordinator {
	if clock == nil {
		clock = SystemClock{}
	}
	return &Coordinator{
		clock:    clock,
		sessions: make(map[SessionID]*sessionState),
		locks:    make(map[string]*lockState),
	}
}

// OpenSession implements Backend.
func (c *Coordinator) OpenSession(ttl time.Duration, notify func(Event)) (SessionID, error) {
	if ttl <= 0 {
		return 0, ErrInvalidTTL
	}
	if notify == nil {
		return 0, ErrInvalidCallback
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return 0, ErrClosed
	}

	c.nextSessionID++
	s := &sessionState{
		id:       SessionID(c.nextSessionID),
		ttl:      ttl,
		alive:    true,
		notify:   notify,
		held:     make(map[string]*heldState),
		requests: make(map[RequestID]*requestState),
	}
	c.sessions[s.id] = s
	c.renewLocked(s)
	return s.id, nil
}

// KeepAlive implements Backend.
func (c *Coordinator) KeepAlive(session SessionID) error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return ErrClosed
	}
	s, expired := c.sessionLocked(session)
	if s == nil {
		c.mu.Unlock()
		deliverAll(expired)
		return ErrSessionLost
	}
	c.renewLocked(s)
	c.mu.Unlock()
	return nil
}

// CloseSession implements Backend.
func (c *Coordinator) CloseSession(session SessionID) error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	s, expired := c.sessionLocked(session)
	if s == nil {
		c.mu.Unlock()
		deliverAll(expired)
		return nil
	}
	deliveries := c.endSessionLocked(s, ErrDisconnected)
	c.mu.Unlock()
	deliverAll(deliveries)
	return nil
}

// Disconnect simulates an abrupt transport failure for a session. Its leases
// and locks are invalidated immediately; the client is notified with
// ErrDisconnected and must Reconnect to obtain a new session.
func (c *Coordinator) Disconnect(session SessionID) {
	c.mu.Lock()
	s, expired := c.sessionLocked(session)
	if s == nil {
		c.mu.Unlock()
		deliverAll(expired)
		return
	}
	deliveries := c.endSessionLocked(s, ErrDisconnected)
	c.mu.Unlock()
	deliverAll(deliveries)
}

// Acquire implements Backend.
func (c *Coordinator) Acquire(session SessionID, request RequestID, lock string) (uint64, error) {
	if lock == "" {
		return 0, ErrInvalidLock
	}
	if request == 0 {
		return 0, ErrInvalidRequest
	}

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return 0, ErrClosed
	}
	s, expired := c.sessionLocked(session)
	if s == nil {
		c.mu.Unlock()
		deliverAll(expired)
		return 0, ErrSessionLost
	}

	if previous := s.requests[request]; previous != nil {
		if previous.lock != lock {
			c.mu.Unlock()
			return 0, ErrDuplicateRequest
		}
		sequence := previous.sequence
		if previous.status == requestGranted {
			depth := 1
			reentrant := false
			if h := s.held[previous.lock]; h != nil && h.token == previous.token {
				depth = h.depth
				reentrant = h.depth > 1
			}
			event := Event{
				Type:      EventGranted,
				Session:   s.id,
				Lock:      previous.lock,
				Request:   previous.id,
				Sequence:  previous.sequence,
				Token:     previous.token,
				Reentrant: reentrant,
				Depth:     depth,
			}
			c.mu.Unlock()
			s.notify(event)
			return sequence, nil
		}
		c.mu.Unlock()
		return sequence, nil
	}

	c.nextSequence++
	r := &requestState{
		id:       request,
		sequence: c.nextSequence,
		lock:     lock,
		session:  s,
		status:   requestPending,
	}
	s.requests[request] = r

	l := c.locks[lock]
	if l == nil {
		l = &lockState{name: lock}
		c.locks[lock] = l
	}

	// Reentrancy is local to the already-owning session and must not wait
	// behind other sessions. It keeps the original fencing token.
	if h := s.held[lock]; h != nil {
		h.depth++
		l.depth++
		r.status = requestGranted
		r.token = h.token
		event := Event{
			Type:      EventGranted,
			Session:   s.id,
			Lock:      lock,
			Request:   request,
			Sequence:  r.sequence,
			Token:     h.token,
			Reentrant: true,
			Depth:     h.depth,
		}
		c.mu.Unlock()
		s.notify(event)
		return r.sequence, nil
	}

	var deliveries []delivery
	var err error
	if l.holder == nil {
		// A canceled head can leave a queue behind without a holder. Drain
		// it first so the newly arriving request cannot jump the queue.
		deliveries, err = c.promoteLocked(l)
		if err != nil {
			r.status = requestCanceled
			c.mu.Unlock()
			return r.sequence, err
		}
	}

	if l.holder == nil {
		var token Token
		token, err = c.nextTokenLocked()
		if err != nil {
			r.status = requestCanceled
			c.mu.Unlock()
			return r.sequence, err
		}
		c.grantLocked(l, s, r, token)
		deliveries = append(deliveries, delivery{session: s, event: grantEvent(r, false, 1)})
	} else {
		l.queue = append(l.queue, r)
	}

	c.mu.Unlock()
	deliverAll(deliveries)
	return r.sequence, nil
}

// Cancel implements Backend. If the request was already granted, the grant is
// released so a context cancellation cannot leak ownership.
func (c *Coordinator) Cancel(session SessionID, request RequestID) error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return ErrClosed
	}
	s, expired := c.sessionLocked(session)
	if s == nil {
		c.mu.Unlock()
		deliverAll(expired)
		return ErrSessionLost
	}
	r := s.requests[request]
	if r == nil {
		c.mu.Unlock()
		return nil
	}

	switch r.status {
	case requestPending:
		r.status = requestCanceled
	case requestGranted:
		h := s.held[r.lock]
		if h == nil || h.token != r.token {
			r.status = requestCanceled
			break
		}
		h.depth--
		l := c.locks[r.lock]
		if l != nil && l.depth > 0 {
			l.depth--
		}
		r.status = requestCanceled
		if h.depth > 0 {
			break
		}
		delete(s.held, r.lock)
		for _, other := range s.requests {
			if other.lock == r.lock && other.status == requestGranted {
				other.status = requestCanceled
			}
		}
		if l != nil && l.holder == s {
			l.holder = nil
			l.token = 0
			l.depth = 0
			deliveries, err := c.promoteLocked(l)
			c.mu.Unlock()
			deliverAll(deliveries)
			return err
		}
	}

	c.mu.Unlock()
	return nil
}

// Release implements Backend.
func (c *Coordinator) Release(session SessionID, lock string, token Token) error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return ErrClosed
	}
	s, expired := c.sessionLocked(session)
	if s == nil {
		c.mu.Unlock()
		deliverAll(expired)
		return ErrSessionLost
	}
	h := s.held[lock]
	if h == nil {
		c.mu.Unlock()
		return ErrNotHeld
	}
	if h.token != token {
		c.mu.Unlock()
		return ErrStaleToken
	}

	h.depth--
	l := c.locks[lock]
	if l != nil && l.depth > 0 {
		l.depth--
	}
	if h.depth > 0 {
		c.mu.Unlock()
		return nil
	}

	delete(s.held, lock)
	for _, other := range s.requests {
		if other.lock == lock && other.status == requestGranted {
			other.status = requestCanceled
		}
	}
	if l == nil || l.holder != s {
		c.mu.Unlock()
		return nil
	}

	l.holder = nil
	l.token = 0
	l.depth = 0
	deliveries, err := c.promoteLocked(l)
	c.mu.Unlock()
	deliverAll(deliveries)
	return err
}

// Close stops the coordinator and invalidates every session.
func (c *Coordinator) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true

	var deliveries []delivery
	for _, s := range c.sessions {
		deliveries = append(deliveries, c.endSessionLocked(s, ErrClosed)...)
	}
	c.mu.Unlock()
	deliverAll(deliveries)
	return nil
}

// QueueLength returns the number of live pending requests for lock. It is
// intended for observability and deterministic tests.
func (c *Coordinator) QueueLength(lock string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	l := c.locks[lock]
	if l == nil {
		return 0
	}
	n := 0
	for _, r := range l.queue {
		if r.status == requestPending && r.session != nil && r.session.alive {
			n++
		}
	}
	return n
}

// Holder returns the current owner and fencing token of lock.
func (c *Coordinator) Holder(lock string) (SessionID, Token, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	l := c.locks[lock]
	if l == nil || l.holder == nil {
		return 0, 0, false
	}
	return l.holder.id, l.token, true
}

// PendingRequests returns request ids in FIFO order, excluding canceled and
// expired entries. It is intended for tests and diagnostics.
func (c *Coordinator) PendingRequests(lock string) []RequestID {
	c.mu.Lock()
	defer c.mu.Unlock()
	l := c.locks[lock]
	if l == nil {
		return nil
	}
	var ids []RequestID
	for _, r := range l.queue {
		if r.status == requestPending && r.session != nil && r.session.alive {
			ids = append(ids, r.id)
		}
	}
	return ids
}

func (c *Coordinator) renewLocked(s *sessionState) {
	s.generation++
	generation := s.generation
	if s.timer != nil {
		s.timer.Stop()
	}
	s.leaseTo = c.clock.Now().Add(s.ttl)
	s.timer = c.clock.AfterFunc(s.ttl, func() {
		c.expire(s.id, generation)
	})
}

// sessionLocked returns the live session and lazily expires it if its lease
// deadline has passed but its timer callback has not run yet. Callers must
// deliver the returned events after unlocking.
func (c *Coordinator) sessionLocked(session SessionID) (*sessionState, []delivery) {
	s := c.sessions[session]
	if s == nil || !s.alive {
		return nil, nil
	}
	if !c.clock.Now().Before(s.leaseTo) {
		return nil, c.endSessionLocked(s, ErrLeaseExpired)
	}
	return s, nil
}

func (c *Coordinator) expire(session SessionID, generation uint64) {
	c.mu.Lock()
	s := c.sessions[session]
	if s == nil || !s.alive || s.generation != generation {
		c.mu.Unlock()
		return
	}

	now := c.clock.Now()
	if now.Before(s.leaseTo) {
		// A wall-clock timer may fire a little early. Re-arm instead of
		// expiring a still-valid lease.
		remaining := s.leaseTo.Sub(now)
		s.generation++
		nextGeneration := s.generation
		s.timer = c.clock.AfterFunc(remaining, func() {
			c.expire(s.id, nextGeneration)
		})
		c.mu.Unlock()
		return
	}

	deliveries := c.endSessionLocked(s, ErrLeaseExpired)
	c.mu.Unlock()
	deliverAll(deliveries)
}

func (c *Coordinator) endSessionLocked(s *sessionState, reason error) []delivery {
	if !s.alive {
		return nil
	}
	s.alive = false
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	delete(c.sessions, s.id)

	for _, r := range s.requests {
		if r.status == requestPending {
			r.status = requestCanceled
		}
	}

	var deliveries []delivery
	for lock, h := range s.held {
		deliveries = append(deliveries, delivery{
			session: s,
			event: Event{
				Type:    EventRevoked,
				Session: s.id,
				Lock:    lock,
				Token:   h.token,
			},
		})

		l := c.locks[lock]
		if l != nil && l.holder == s {
			l.holder = nil
			l.token = 0
			l.depth = 0
			promoted, err := c.promoteLocked(l)
			deliveries = append(deliveries, promoted...)
			_ = err // Token exhaustion is unrecoverable; the queue stays put.
		}
	}
	s.held = make(map[string]*heldState)
	s.requests = make(map[RequestID]*requestState)

	deliveries = append(deliveries, delivery{
		session: s,
		event: Event{
			Type:    EventSessionLost,
			Session: s.id,
			Err:     reason,
		},
	})
	return deliveries
}

func (c *Coordinator) promoteLocked(l *lockState) ([]delivery, error) {
	for len(l.queue) > 0 {
		r := l.queue[0]
		l.queue = l.queue[1:]
		if len(l.queue) == 0 {
			l.queue = nil
		}
		if r.status != requestPending {
			continue
		}
		if r.session == nil || !r.session.alive {
			r.status = requestCanceled
			continue
		}

		token, err := c.nextTokenLocked()
		if err != nil {
			l.queue = append([]*requestState{r}, l.queue...)
			return nil, err
		}
		c.grantLocked(l, r.session, r, token)
		return []delivery{{
			session: r.session,
			event:   grantEvent(r, false, 1),
		}}, nil
	}
	return nil, nil
}

func (c *Coordinator) grantLocked(l *lockState, s *sessionState, r *requestState, token Token) {
	l.holder = s
	l.token = token
	l.depth = 1
	s.held[l.name] = &heldState{token: token, depth: 1}
	r.status = requestGranted
	r.token = token
}

func (c *Coordinator) nextTokenLocked() (Token, error) {
	if c.nextToken == math.MaxUint64 {
		return 0, ErrTokenExhausted
	}
	c.nextToken++
	return Token(c.nextToken), nil
}

func grantEvent(r *requestState, reentrant bool, depth int) Event {
	return Event{
		Type:      EventGranted,
		Session:   r.session.id,
		Lock:      r.lock,
		Request:   r.id,
		Sequence:  r.sequence,
		Token:     r.token,
		Reentrant: reentrant,
		Depth:     depth,
	}
}

func deliverAll(deliveries []delivery) {
	for _, d := range deliveries {
		if d.session != nil && d.session.notify != nil {
			d.session.notify(d.event)
		}
	}
}
