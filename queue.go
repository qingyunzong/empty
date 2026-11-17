package formal

import (
	"container/heap"
	"container/list"
	"context"
	"fmt"
	"sync"
	"time"
)

// Queue coalesces watch events, orders deliveries, applies retry backoff, and
// rate limits delivery with a global bucket and one bucket per namespace.
//
// At most one event for an object is in flight at a time. A newer version may
// replace an event that is waiting, but it never preempts an event already
// returned by Get. Once a version has been delivered, duplicate or stale watch
// observations of that version are ignored. Fail intentionally creates a new
// delivery attempt for the same object and version; that is the one case where
// the same resource version can be returned more than once.
type Queue struct {
	mu sync.Mutex

	cfg    Config
	now    func() time.Time
	global tokenBucket

	states       map[ObjectKey]*objectState
	namespaces   map[string]*namespaceQueue
	ring         *list.List
	cursor       *list.Element
	delayed      delayedHeap
	ready        int
	inFlight     int
	nextLease    uint64
	shuttingDown bool

	wake   chan struct{}
	closed chan struct{}
}

type objectState struct {
	key ObjectKey

	seenSet bool
	seen    uint64

	deliveredSet bool
	delivered    uint64

	pending  *pendingEvent
	inFlight *inflightEvent
	attempts int
}

type pendingEvent struct {
	event Event
	state *objectState
	ready *list.Element
	delay *delayedEvent
}

type inflightEvent struct {
	event Event
	lease uint64
}

type namespaceQueue struct {
	name   string
	items  *list.List
	ring   *list.Element
	bucket tokenBucket
}

// Stats is a point-in-time view of queue occupancy.
type Stats struct {
	Pending    int
	Ready      int
	Delayed    int
	InFlight   int
	Namespaces int
}

// NewQueue creates a queue. With no arguments it uses DefaultConfig. Only the
// first Config is used.
func NewQueue(configs ...Config) *Queue {
	cfg := DefaultConfig()
	if len(configs) > 0 {
		cfg = configs[0]
	}
	cfg = cfg.normalized()

	now := cfg.Now
	return &Queue{
		cfg:        cfg,
		now:        now,
		global:     newTokenBucket(cfg.Global, now()),
		states:     make(map[ObjectKey]*objectState),
		namespaces: make(map[string]*namespaceQueue),
		ring:       list.New(),
		wake:       make(chan struct{}),
		closed:     make(chan struct{}),
	}
}

// New is an alias for NewQueue.
func New(configs ...Config) *Queue {
	return NewQueue(configs...)
}

// Add enqueues an event. It returns false for an invalid key, a stale version,
// or an already-pending/delivered version.
func (q *Queue) Add(event Event) bool {
	return q.add(event, q.now())
}

// Enqueue is an alias for Add.
func (q *Queue) Enqueue(event Event) bool {
	return q.Add(event)
}

// AddAfter enqueues an event that becomes eligible after delay. A newer event
// for the same object can still replace it.
func (q *Queue) AddAfter(event Event, delay time.Duration) bool {
	return q.add(event, q.now().Add(delay))
}

func (q *Queue) add(event Event, at time.Time) bool {
	event = event.normalized()
	if event.Name == "" {
		return false
	}
	event.lease = 0
	version := event.resourceVersion()
	key := event.Key()

	q.mu.Lock()
	defer q.mu.Unlock()

	if q.shuttingDown {
		return false
	}

	state := q.states[key]
	if state == nil {
		state = &objectState{key: key}
		q.states[key] = state
	}

	if state.seenSet {
		switch {
		case version < state.seen:
			return false
		case version == state.seen:
			// An equal version may replace a waiting update when it is a
			// tombstone: the stronger observation wins without consuming a
			// second delivery. It may also be re-added after a cancelled
			// pending event. It must never duplicate an in-flight or already
			// delivered version.
			if state.inFlight != nil {
				return false
			}
			if state.pending != nil && !(event.IsDelete() && !state.pending.event.IsDelete()) {
				return false
			}
			if state.deliveredSet && state.delivered >= version {
				return false
			}
		}
	}

	newer := !state.seenSet || version > state.seen
	if state.inFlight != nil {
		if state.pending != nil {
			q.removePendingLocked(state.pending)
		}
		pending := &pendingEvent{event: event, state: state}
		state.pending = pending
		state.seenSet = true
		state.seen = version
		if newer {
			state.attempts = 0
		}
		q.signalLocked()
		return true
	}

	if state.pending != nil {
		q.removePendingLocked(state.pending)
	}
	pending := &pendingEvent{event: event, state: state}
	state.pending = pending
	state.seenSet = true
	state.seen = version
	if newer {
		state.attempts = 0
	}
	q.schedulePendingLocked(pending, at)
	q.signalLocked()
	return true
}

// Get waits for the next deliverable event. Passing a context is optional:
// Get() blocks until an event is available or the queue is shut down;
// Get(ctx) additionally stops when ctx is cancelled.
//
// The returned Event carries an opaque delivery lease. Pass that same Event to
// Done or Fail. When Get returns false, the queue is shut down or the context
// was cancelled.
func (q *Queue) Get(contexts ...context.Context) (Event, bool) {
	ctx := context.Background()
	if len(contexts) > 0 && contexts[0] != nil {
		ctx = contexts[0]
	}

	for {
		q.mu.Lock()
		if q.shuttingDown {
			q.mu.Unlock()
			return Event{}, false
		}

		now := q.now()
		q.promoteDueLocked(now)
		if event, ok := q.popLocked(now); ok {
			q.mu.Unlock()
			return event, true
		}

		wait := q.nextWaitLocked(now)
		wake := q.wake
		q.mu.Unlock()

		if ctx.Err() != nil {
			return Event{}, false
		}

		var timer *time.Timer
		var timerC <-chan time.Time
		if wait > 0 {
			timer = time.NewTimer(wait)
			timerC = timer.C
		}

		select {
		case <-ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			return Event{}, false
		case <-q.closed:
			if timer != nil {
				timer.Stop()
			}
			return Event{}, false
		case <-wake:
			if timer != nil {
				timer.Stop()
			}
		case <-timerC:
		}
	}
}

// TryGet returns an immediately available event without blocking.
func (q *Queue) TryGet() (Event, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.shuttingDown {
		return Event{}, false
	}
	now := q.now()
	q.promoteDueLocked(now)
	return q.popLocked(now)
}

// Done marks a successful delivery. The event may be the exact Event returned
// by Get, a copy of it, or its ObjectKey. Stale completions are rejected.
func (q *Queue) Done(target any) bool {
	q.mu.Lock()
	defer q.mu.Unlock()

	state, inflight := q.matchInFlightLocked(target)
	if inflight == nil {
		return false
	}
	q.clearInFlightLocked(state, true)
	q.signalLocked()
	return true
}

// Forget is an alias for Done. It clears the in-flight delivery and any
// accumulated backoff state.
func (q *Queue) Forget(target any) bool {
	return q.Done(target)
}

// Fail marks a delivery as failed. The error class selects an exponential
// backoff policy. Terminal errors are not retried. If a newer version is
// already waiting, the newer version is promoted instead of retrying the old
// one.
func (q *Queue) Fail(target any, err error) bool {
	q.mu.Lock()
	defer q.mu.Unlock()

	state, inflight := q.matchInFlightLocked(target)
	if inflight == nil {
		return false
	}

	event := inflight.event
	event.lease = 0
	hadNewerPending := state.pending != nil
	q.clearInFlightLocked(state, false)

	class := q.cfg.Classify(err)
	if class != ErrorClassTerminal && !hadNewerPending {
		state.attempts++
		delay := q.backoffFor(class).Delay(state.attempts)
		pending := &pendingEvent{event: event, state: state}
		state.pending = pending
		q.schedulePendingLocked(pending, q.now().Add(delay))
	}
	q.signalLocked()
	return true
}

// AddRateLimited is an alias for Fail.
func (q *Queue) AddRateLimited(target any, err error) bool {
	return q.Fail(target, err)
}

// Cancel removes a waiting event or invalidates an in-flight delivery. It
// accepts an Event, *Event, ObjectKey, or a "namespace/name" string. A
// cancelled event that had not been delivered may be re-added with the same
// version; a delivered version remains deduplicated.
func (q *Queue) Cancel(target any) bool {
	q.mu.Lock()
	defer q.mu.Unlock()

	event, ok := eventTarget(target)
	if !ok {
		return false
	}
	state := q.states[event.Key()]
	if state == nil {
		return false
	}

	cancelled := false
	if state.inFlight != nil && targetMatches(event, state.inFlight.event) {
		q.clearInFlightLocked(state, false)
		cancelled = true
	}

	keyOnly := event.lease == 0 && event.resourceVersion() == 0
	if state.pending != nil && (keyOnly || targetMatches(event, state.pending.event)) {
		q.removePendingLocked(state.pending)
		state.pending = nil
		cancelled = true
	}
	if cancelled {
		q.signalLocked()
	}
	return cancelled
}

func (q *Queue) clearInFlightLocked(state *objectState, resetAttempts bool) {
	state.inFlight = nil
	if resetAttempts {
		state.attempts = 0
	}
	q.inFlight--
	if state.pending != nil {
		q.schedulePendingLocked(state.pending, q.now())
	}
}

func (q *Queue) matchInFlightLocked(target any) (*objectState, *inflightEvent) {
	event, ok := eventTarget(target)
	if !ok {
		return nil, nil
	}
	state := q.states[event.Key()]
	if state == nil || state.inFlight == nil {
		return nil, nil
	}
	if !targetMatches(event, state.inFlight.event) {
		return nil, nil
	}
	return state, state.inFlight
}

func targetMatches(target, inflight Event) bool {
	if target.Key() != inflight.Key() {
		return false
	}
	if target.lease != 0 && target.lease != inflight.lease {
		return false
	}
	targetVersion := target.resourceVersion()
	if targetVersion != 0 && targetVersion != inflight.resourceVersion() {
		return false
	}
	return true
}

func eventTarget(target any) (Event, bool) {
	switch value := target.(type) {
	case Event:
		return value.normalized(), true
	case *Event:
		if value == nil {
			return Event{}, false
		}
		return value.normalized(), true
	case ObjectKey:
		return Event{Namespace: value.Namespace, Name: value.Name}, true
	case *ObjectKey:
		if value == nil {
			return Event{}, false
		}
		return Event{Namespace: value.Namespace, Name: value.Name}, true
	case string:
		key := ParseKey(value)
		return Event{Namespace: key.Namespace, Name: key.Name}, true
	default:
		return Event{}, false
	}
}

func (q *Queue) schedulePendingLocked(pending *pendingEvent, at time.Time) {
	if pending == nil || pending.state.pending != pending || pending.state.inFlight != nil {
		return
	}
	q.removePendingLocked(pending)
	now := q.now()
	if at.After(now) {
		item := &delayedEvent{at: at, pending: pending}
		heap.Push(&q.delayed, item)
		pending.delay = item
		return
	}
	q.enqueueReadyLocked(pending, pending.event.IsDelete())
}

func (q *Queue) removePendingLocked(pending *pendingEvent) {
	if pending == nil {
		return
	}
	if pending.ready != nil {
		namespace := q.namespaces[pending.event.Namespace]
		if namespace != nil && namespace.items != nil {
			namespace.items.Remove(pending.ready)
		}
		pending.ready = nil
		q.ready--
		if namespace != nil && namespace.items.Len() == 0 {
			q.removeNamespaceLocked(namespace)
		}
	}
	if pending.delay != nil {
		q.delayed.remove(pending.delay)
		pending.delay = nil
	}
}

func (q *Queue) promoteDueLocked(now time.Time) {
	for q.delayed.Len() > 0 {
		next := q.delayed[0]
		if next.at.After(now) {
			return
		}
		heap.Pop(&q.delayed)
		pending := next.pending
		next.pending = nil
		pending.delay = nil
		if pending.state.pending != pending || pending.state.inFlight != nil {
			continue
		}
		q.enqueueReadyLocked(pending, pending.event.IsDelete())
	}
}

func (q *Queue) enqueueReadyLocked(pending *pendingEvent, front bool) {
	namespace := q.namespaceLocked(pending.event.Namespace)
	if namespace.items.Len() == 0 {
		namespace.ring = q.ring.PushBack(namespace)
		if q.cursor == nil {
			q.cursor = q.ring.Front()
		}
	}

	var element *list.Element
	if front {
		element = namespace.items.PushFront(pending)
	} else {
		element = namespace.items.PushBack(pending)
	}
	pending.ready = element
	q.ready++
}

func (q *Queue) popLocked(now time.Time) (Event, bool) {
	if q.ring.Len() == 0 || !q.global.ready(now) {
		return Event{}, false
	}
	start := q.cursor
	if start == nil {
		start = q.ring.Front()
		q.cursor = start
	}

	element := start
	for checked := 0; checked < q.ring.Len(); checked++ {
		namespace := element.Value.(*namespaceQueue)
		if namespace.items.Len() > 0 && namespace.bucket.ready(now) {
			entry := namespace.items.Front()
			pending := entry.Value.(*pendingEvent)
			namespace.items.Remove(entry)
			pending.ready = nil
			q.ready--

			if namespace.items.Len() == 0 {
				q.removeNamespaceLocked(namespace)
			} else {
				q.cursor = nextRingElement(q.ring, namespace.ring)
			}

			q.global.consume(now)
			namespace.bucket.consume(now)
			return q.deliverLocked(pending), true
		}
		element = nextRingElement(q.ring, element)
	}
	q.cursor = element
	return Event{}, false
}

func (q *Queue) deliverLocked(pending *pendingEvent) Event {
	q.nextLease++
	if q.nextLease == 0 {
		q.nextLease = 1
	}
	event := pending.event
	event.lease = q.nextLease

	state := pending.state
	state.pending = nil
	state.inFlight = &inflightEvent{event: event, lease: event.lease}
	state.deliveredSet = true
	version := event.resourceVersion()
	if version > state.delivered {
		state.delivered = version
	}
	q.inFlight++
	return event
}

func (q *Queue) nextWaitLocked(now time.Time) time.Duration {
	delayWait := q.nextDelayedWaitLocked(now)
	if q.ring.Len() == 0 {
		return delayWait
	}
	if q.global.enabled() && !q.global.ready(now) {
		return minPositiveDuration(q.global.wait(now), delayWait)
	}

	minimum := time.Duration(-1)
	for element := q.ring.Front(); element != nil; element = element.Next() {
		namespace := element.Value.(*namespaceQueue)
		if namespace.items.Len() == 0 {
			continue
		}
		wait := namespace.bucket.wait(now)
		if wait <= 0 {
			minimum = 0
			break
		}
		if minimum < 0 || wait < minimum {
			minimum = wait
		}
	}
	if minimum < 0 {
		return delayWait
	}
	return minPositiveDuration(minimum, delayWait)
}

func (q *Queue) nextDelayedWaitLocked(now time.Time) time.Duration {
	if q.delayed.Len() == 0 {
		return -1
	}
	wait := q.delayed[0].at.Sub(now)
	if wait <= 0 {
		return 0
	}
	return wait
}

func minPositiveDuration(left, right time.Duration) time.Duration {
	switch {
	case left < 0:
		return right
	case right < 0:
		return left
	case left < right:
		return left
	default:
		return right
	}
}

func nextRingElement(ring *list.List, current *list.Element) *list.Element {
	if ring == nil || ring.Len() == 0 {
		return nil
	}
	if current == nil {
		return ring.Front()
	}
	if next := current.Next(); next != nil {
		return next
	}
	return ring.Front()
}

func (q *Queue) removeNamespaceLocked(namespace *namespaceQueue) {
	if namespace == nil || namespace.ring == nil {
		return
	}
	wasCursor := q.cursor == namespace.ring
	next := namespace.ring.Next()
	if next == nil {
		next = q.ring.Front()
	}
	q.ring.Remove(namespace.ring)
	namespace.ring = nil
	if q.ring.Len() == 0 {
		q.cursor = nil
		return
	}
	if wasCursor {
		if next == nil || next.Value == nil {
			q.cursor = q.ring.Front()
		} else {
			q.cursor = next
		}
	}
	if q.cursor == nil {
		q.cursor = q.ring.Front()
	}
}

func (q *Queue) namespaceLocked(name string) *namespaceQueue {
	if namespace := q.namespaces[name]; namespace != nil {
		return namespace
	}
	limit := q.cfg.Namespace
	if override, ok := q.cfg.NamespaceLimits[name]; ok {
		limit = override
	}
	namespace := &namespaceQueue{
		name:   name,
		items:  list.New(),
		bucket: newTokenBucket(limit, q.now()),
	}
	q.namespaces[name] = namespace
	return namespace
}

func (q *Queue) backoffFor(class ErrorClass) Backoff {
	if policy, ok := q.cfg.Backoff[class]; ok {
		return policy
	}
	return q.cfg.DefaultBackoff
}

func (q *Queue) signalLocked() {
	close(q.wake)
	q.wake = make(chan struct{})
}

// Len returns the number of waiting events, including events in retry backoff.
// In-flight events are reported separately by Stats.
func (q *Queue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.ready + q.delayed.Len()
}

// ReadyLen returns the number of events currently eligible for delivery.
func (q *Queue) ReadyLen() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.ready
}

// Stats returns queue occupancy.
func (q *Queue) Stats() Stats {
	q.mu.Lock()
	defer q.mu.Unlock()
	return Stats{
		Pending:    q.ready + q.delayed.Len(),
		Ready:      q.ready,
		Delayed:    q.delayed.Len(),
		InFlight:   q.inFlight,
		Namespaces: q.ring.Len(),
	}
}

// ShutDown stops all future Get calls. Waiting Get calls return false.
func (q *Queue) ShutDown() {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.shuttingDown {
		return
	}
	q.shuttingDown = true
	close(q.closed)
	q.signalLocked()
}

// Shutdown is an alias for ShutDown.
func (q *Queue) Shutdown() {
	q.ShutDown()
}

// ShuttingDown reports whether ShutDown has been called.
func (q *Queue) ShuttingDown() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.shuttingDown
}

// Close implements io.Closer.
func (q *Queue) Close() error {
	q.ShutDown()
	return nil
}

func (q *Queue) String() string {
	stats := q.Stats()
	return fmt.Sprintf("queue{pending:%d ready:%d delayed:%d inflight:%d namespaces:%d}",
		stats.Pending, stats.Ready, stats.Delayed, stats.InFlight, stats.Namespaces)
}
