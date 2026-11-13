package dataeng

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// ErrLeaseLost is returned when a delivery's lease is no longer valid:
// it expired, was nacked, or the ordering key was re-leased to another
// processor. The holder of a lost lease must not commit.
var ErrLeaseLost = errors.New("dataeng: lease lost")

const defaultAckDeadline = 30 * time.Second

// Message is a unit of work flowing through a Subscription.
type Message struct {
	ID          string
	OrderingKey string
	Data        []byte
	// PublishSeq is the per-subscription publish sequence, assigned on Publish.
	PublishSeq int64
	// Attempt counts deliveries; 1 on first delivery, incremented on redelivery.
	Attempt int
}

// group is the scheduling unit. Ordered messages share a group per ordering
// key; unordered messages each get their own group so they progress
// independently.
type group struct {
	queue []*Message // unacked messages in publish order; head may be leased
	lease *leaseState
	epoch uint64 // fencing token source, incremented on every new lease
}

type leaseState struct {
	epoch    uint64
	deadline time.Time
}

// Subscription coordinates ack deadlines, modifyAckDeadline, nack and
// redelivery for one logical subscription. For any ordering key at most one
// message (the active prefix) is leased at a time; a new lease invalidates
// the previous one via a fencing epoch.
type Subscription struct {
	mu          sync.Mutex
	ackDeadline time.Duration
	now         func() time.Time
	gen         uint64 // bumped on RestoreFrom, fencing all live deliveries
	nextSeq     int64
	groups      map[string]*group
	acked       map[string]struct{}
}

// Option customizes a Subscription.
type Option func(*Subscription)

// WithAckDeadline sets the initial lease duration for each delivery.
func WithAckDeadline(d time.Duration) Option {
	return func(s *Subscription) { s.ackDeadline = d }
}

// WithClock overrides the time source, mainly for tests.
func WithClock(now func() time.Time) Option {
	return func(s *Subscription) { s.now = now }
}

// NewSubscription creates an empty subscription.
func NewSubscription(opts ...Option) *Subscription {
	s := &Subscription{
		ackDeadline: defaultAckDeadline,
		now:         time.Now,
		groups:      make(map[string]*group),
		acked:       make(map[string]struct{}),
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// groupKey maps a message to its scheduling group. Ordered messages share
// their ordering key; unordered messages are independent of each other.
func groupKey(m *Message) string {
	if m.OrderingKey == "" {
		return "\x00u:" + m.ID
	}
	return "\x00o:" + m.OrderingKey
}

// Publish appends a message, preserving per-ordering-key publish order.
// It assigns ID and PublishSeq when unset and returns the stored message.
func (s *Subscription) Publish(msg Message) *Message {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextSeq++
	if msg.ID == "" {
		msg.ID = fmt.Sprintf("msg-%d", s.nextSeq)
	}
	if msg.PublishSeq == 0 {
		msg.PublishSeq = s.nextSeq
	}
	m := msg
	key := groupKey(&m)
	g := s.groups[key]
	if g == nil {
		g = &group{}
		s.groups[key] = g
	}
	g.queue = append(g.queue, &m)
	return &m
}

// Delivery is a leased message handle. All commit paths (Ack, Nack, Extend)
// are fenced: they fail with ErrLeaseLost once the lease is gone.
type Delivery struct {
	sub      *Subscription
	groupKey string
	msg      Message
	epoch    uint64
	gen      uint64
}

// Message returns the leased message snapshot.
func (d *Delivery) Message() Message { return d.msg }

// checkLeaseLocked validates the fencing token and deadline.
func (s *Subscription) checkLeaseLocked(d *Delivery) (*group, error) {
	if d.gen != s.gen {
		return nil, ErrLeaseLost
	}
	g := s.groups[d.groupKey]
	if g == nil || g.lease == nil || g.lease.epoch != d.epoch {
		return nil, ErrLeaseLost
	}
	if !s.now().Before(g.lease.deadline) {
		g.lease = nil
		return nil, ErrLeaseLost
	}
	if len(g.queue) == 0 || g.queue[0].ID != d.msg.ID {
		return nil, ErrLeaseLost
	}
	return g, nil
}

// Ack commits the message. It fails with ErrLeaseLost if the lease expired
// or the ordering key has since been re-leased.
func (d *Delivery) Ack() error {
	s := d.sub
	s.mu.Lock()
	defer s.mu.Unlock()
	g, err := s.checkLeaseLocked(d)
	if err != nil {
		return err
	}
	g.queue = g.queue[1:]
	g.lease = nil
	s.acked[d.msg.ID] = struct{}{}
	if len(g.queue) == 0 && d.msg.OrderingKey == "" {
		delete(s.groups, d.groupKey) // unordered groups are single-use
	}
	return nil
}

// Nack is modifyAckDeadline(0): the message becomes immediately
// redeliverable as the head of its ordering key.
func (d *Delivery) Nack() error {
	s := d.sub
	s.mu.Lock()
	defer s.mu.Unlock()
	g, err := s.checkLeaseLocked(d)
	if err != nil {
		return err
	}
	g.lease = nil
	return nil
}

// Extend is modifyAckDeadline(d): it moves the lease deadline to now+d.
func (d *Delivery) Extend(dur time.Duration) error {
	s := d.sub
	s.mu.Lock()
	defer s.mu.Unlock()
	g, err := s.checkLeaseLocked(d)
	if err != nil {
		return err
	}
	g.lease.deadline = s.now().Add(dur)
	return nil
}

// expireLocked drops leases whose deadline has passed, making their
// messages eligible for redelivery.
func (s *Subscription) expireLocked(now time.Time) {
	for _, g := range s.groups {
		if g.lease != nil && !now.Before(g.lease.deadline) {
			g.lease = nil
		}
	}
}

// Pull leases up to max deliverable messages. Each ordering key contributes
// at most its head message, and only when no lease is active for the key.
// Expired leases are reclaimed first, driving subscription redelivery.
func (s *Subscription) Pull(_ context.Context, max int) []*Delivery {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.expireLocked(now)

	keys := make([]string, 0, len(s.groups))
	for key, g := range s.groups {
		if g.lease == nil && len(g.queue) > 0 {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys) // deterministic delivery order
	if len(keys) > max {
		keys = keys[:max]
	}

	out := make([]*Delivery, 0, len(keys))
	for _, key := range keys {
		g := s.groups[key]
		g.epoch++
		g.lease = &leaseState{epoch: g.epoch, deadline: now.Add(s.ackDeadline)}
		head := g.queue[0]
		head.Attempt++
		out = append(out, &Delivery{
			sub:      s,
			groupKey: key,
			msg:      *head,
			epoch:    g.epoch,
			gen:      s.gen,
		})
	}
	return out
}

// Pending reports the number of unacked messages.
func (s *Subscription) Pending() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, g := range s.groups {
		n += len(g.queue)
	}
	return n
}

// Snapshot captures all unacked messages grouped by scheduling group, in
// per-key publish order, plus the set of acked message IDs. In-flight
// leases are not carried over; after Restore those messages become
// deliverable again at the head of their key.
type Snapshot struct {
	NextSeq int64
	Groups  map[string][]Message
	Acked   []string
}

// Snapshot records the current unacked state.
func (s *Subscription) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	snap := Snapshot{
		NextSeq: s.nextSeq,
		Groups:  make(map[string][]Message, len(s.groups)),
	}
	for key, g := range s.groups {
		msgs := make([]Message, len(g.queue))
		for i, m := range g.queue {
			msgs[i] = *m
		}
		snap.Groups[key] = msgs
	}
	for id := range s.acked {
		snap.Acked = append(snap.Acked, id)
	}
	sort.Strings(snap.Acked)
	return snap
}

// Restore rebuilds a subscription from a snapshot. Per-key publish order is
// preserved; previously in-flight messages are redeliverable from the head
// of their ordering key.
func Restore(snap Snapshot, opts ...Option) *Subscription {
	s := NewSubscription(opts...)
	s.RestoreFrom(snap)
	return s
}

// RestoreFrom replaces the subscription state with a snapshot and bumps the
// fencing generation, so every delivery leased before the restore fails with
// ErrLeaseLost. It models a lease handoff after crash recovery.
func (s *Subscription) RestoreFrom(snap Snapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gen++
	s.nextSeq = snap.NextSeq
	s.groups = make(map[string]*group, len(snap.Groups))
	s.acked = make(map[string]struct{}, len(snap.Acked))
	for key, msgs := range snap.Groups {
		g := &group{}
		for i := range msgs {
			m := msgs[i]
			g.queue = append(g.queue, &m)
		}
		s.groups[key] = g
	}
	for _, id := range snap.Acked {
		s.acked[id] = struct{}{}
	}
}
