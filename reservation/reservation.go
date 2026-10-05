// Package reservation implements an event-sourced inventory reservation
// system. Reservations may span multiple stock batches; confirm, cancel
// and expiry are decided strictly by event order. The expiry instant is
// inclusive of the deadline: at t == ExpireAt the reservation is expired.
// Confirm transfers the whole reserved batch set atomically.
package reservation

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

var (
	ErrRequestConflict   = errors.New("request ID already bound to different parameters")
	ErrBatchNotFound     = errors.New("batch not found")
	ErrInsufficientStock = errors.New("insufficient stock")
	ErrInvalidQuantity   = errors.New("quantity must be positive")
	ErrEmptyReservation  = errors.New("reservation must contain at least one batch")
	ErrNotActive         = errors.New("reservation is not active")
	ErrExpired           = errors.New("reservation expired")
	ErrLogCorrupt        = errors.New("event log cannot be replayed")
)

// State is the lifecycle state of a reservation.
type State string

const (
	Active    State = "active"
	Confirmed State = "confirmed"
	Cancelled State = "cancelled"
	Expired   State = "expired"
)

// Kind is the event kind recorded in the log.
type Kind string

const (
	EventStock   Kind = "stock"
	EventReserve Kind = "reserve"
	EventConfirm Kind = "confirm"
	EventCancel  Kind = "cancel"
	EventExpire  Kind = "expire"
)

// Event is a single entry in the append-only log. Seq decides the order
// in which conflicting transitions are resolved.
type Event struct {
	Seq           uint64
	Kind          Kind
	Time          time.Time
	RequestID     string
	BatchID       string         // stock
	Quantity      int            // stock
	Items         map[string]int // reserve: batch -> quantity
	ExpireAt      time.Time      // reserve
	ReservationID string         // confirm/cancel/expire
}

// Batch is one stock location ("货位") of inventory.
type Batch struct {
	ID        string
	Initial   int
	Available int
	Reserved  int // held by active reservations
	Confirmed int // transferred out by confirms
}

// Reservation is a hold spanning one or more batches.
type Reservation struct {
	ID         string
	RequestID  string
	Generation uint64
	Items      map[string]int
	ExpireAt   time.Time
	State      State
	CreatedSeq uint64
	ClosedSeq  uint64
}

// requestRecord binds a request ID to its parameters and outcome.
type requestRecord struct {
	fingerprint   string
	reservationID string
	err           error
}

// Store holds inventory, reservations and the event log.
type Store struct {
	batches      map[string]*Batch
	batchOrder   []string
	reservations map[string]*Reservation
	requests     map[string]requestRecord
	seq          uint64
	gen          uint64
	log          []Event
}

func NewStore() *Store {
	return &Store{
		batches:      map[string]*Batch{},
		reservations: map[string]*Reservation{},
		requests:     map[string]requestRecord{},
	}
}

// Log returns a copy of the event log.
func (s *Store) Log() []Event {
	out := make([]Event, len(s.log))
	copy(out, s.log)
	return out
}

// Batch returns a batch by ID, or nil.
func (s *Store) Batch(id string) *Batch { return s.batches[id] }

// Reservation returns a reservation by ID, or nil.
func (s *Store) Reservation(id string) *Reservation { return s.reservations[id] }

func fingerprintReserve(items map[string]int, expireAt time.Time) string {
	keys := make([]string, 0, len(items))
	for k := range items {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString("reserve|")
	for _, k := range keys {
		fmt.Fprintf(&b, "%s=%d;", k, items[k])
	}
	fmt.Fprintf(&b, "@%d", expireAt.UnixNano())
	return b.String()
}

// checkRequest enforces request-ID parameter binding. It returns the
// recorded outcome when the same request ID is retried with identical
// parameters.
func (s *Store) checkRequest(requestID, fingerprint string) (requestRecord, bool, error) {
	if requestID == "" {
		return requestRecord{}, false, errors.New("request ID must not be empty")
	}
	rec, ok := s.requests[requestID]
	if !ok {
		return requestRecord{}, false, nil
	}
	if rec.fingerprint != fingerprint {
		return requestRecord{}, false, ErrRequestConflict
	}
	return rec, true, nil
}

// Stock seeds a batch with initial quantity. Seeding is itself an event so
// the log is self-contained and replayable.
func (s *Store) Stock(now time.Time, batchID string, quantity int) error {
	if quantity <= 0 {
		return ErrInvalidQuantity
	}
	return s.apply(Event{Kind: EventStock, Time: now, BatchID: batchID, Quantity: quantity})
}

// Reserve places a hold spanning the given batches. The same request ID
// with identical parameters returns the original reservation; with
// different parameters it fails with ErrRequestConflict. Each successful
// reserve receives a new, strictly increasing generation.
func (s *Store) Reserve(now time.Time, requestID string, items map[string]int, expireAt time.Time) (*Reservation, error) {
	fp := fingerprintReserve(items, expireAt)
	rec, replay, err := s.checkRequest(requestID, fp)
	if err != nil {
		return nil, err
	}
	if replay {
		return s.reservations[rec.reservationID], rec.err
	}
	r, err := s.reserve(now, requestID, items, expireAt)
	s.requests[requestID] = requestRecord{fingerprint: fp, reservationID: reservationIDOf(r), err: err}
	return r, err
}

func reservationIDOf(r *Reservation) string {
	if r == nil {
		return ""
	}
	return r.ID
}

func (s *Store) reserve(now time.Time, requestID string, items map[string]int, expireAt time.Time) (*Reservation, error) {
	if len(items) == 0 {
		return nil, ErrEmptyReservation
	}
	for batchID, qty := range items {
		if qty <= 0 {
			return nil, ErrInvalidQuantity
		}
		b, ok := s.batches[batchID]
		if !ok {
			return nil, fmt.Errorf("%w: %s", ErrBatchNotFound, batchID)
		}
		if b.Available < qty {
			return nil, fmt.Errorf("%w: batch %s has %d, need %d", ErrInsufficientStock, batchID, b.Available, qty)
		}
	}
	ev := Event{Kind: EventReserve, Time: now, RequestID: requestID, Items: items, ExpireAt: expireAt}
	if err := s.apply(ev); err != nil {
		return nil, err
	}
	return s.reservations[fmt.Sprintf("R%06d", s.gen)], nil
}

// Confirm atomically transfers the whole reserved batch set out of the
// batches. If the reservation has reached its deadline (inclusive) it
// expires first and the confirm fails with ErrExpired.
func (s *Store) Confirm(now time.Time, requestID, reservationID string) (*Reservation, error) {
	return s.close(now, requestID, reservationID, EventConfirm)
}

// Cancel releases the hold back to available stock.
func (s *Store) Cancel(now time.Time, requestID, reservationID string) (*Reservation, error) {
	return s.close(now, requestID, reservationID, EventCancel)
}

func (s *Store) close(now time.Time, requestID, reservationID string, kind Kind) (*Reservation, error) {
	fp := string(kind) + "|" + reservationID
	rec, replay, err := s.checkRequest(requestID, fp)
	if err != nil {
		return nil, err
	}
	if replay {
		return s.reservations[rec.reservationID], rec.err
	}
	r, err := s.applyClose(Event{Kind: kind, Time: now, RequestID: requestID, ReservationID: reservationID})
	s.requests[requestID] = requestRecord{fingerprint: fp, reservationID: reservationID, err: err}
	return r, err
}

// applyClose handles confirm/cancel including lazy expiry. It is used by
// live calls; replay uses apply so that logged events are authoritative.
func (s *Store) applyClose(ev Event) (*Reservation, error) {
	r, ok := s.reservations[ev.ReservationID]
	if !ok {
		return nil, fmt.Errorf("%w: unknown reservation %s", ErrNotActive, ev.ReservationID)
	}
	if r.State == Active && expiredAt(r, ev.Time) {
		if err := s.apply(Event{Kind: EventExpire, Time: ev.Time, ReservationID: r.ID}); err != nil {
			return nil, err
		}
	}
	if r.State != Active {
		if r.State == Expired {
			return r, ErrExpired
		}
		return r, fmt.Errorf("%w: reservation %s is %s", ErrNotActive, r.ID, r.State)
	}
	if err := s.apply(ev); err != nil {
		return nil, err
	}
	return r, nil
}

// ExpireDue expires every active reservation whose deadline has passed
// (inclusive), in creation order.
func (s *Store) ExpireDue(now time.Time) {
	ids := make([]string, 0, len(s.reservations))
	for _, r := range s.reservations {
		if r.State == Active && expiredAt(r, now) {
			ids = append(ids, r.ID)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		_ = s.apply(Event{Kind: EventExpire, Time: now, ReservationID: id})
	}
}

// expiredAt reports whether the reservation is expired at t. The expiry
// instant includes the deadline: t >= ExpireAt means expired.
func expiredAt(r *Reservation, t time.Time) bool {
	return !t.Before(r.ExpireAt)
}

// apply appends ev to the log and mutates state. It is the single code
// path shared by live operations and replay.
func (s *Store) apply(ev Event) error {
	s.seq++
	ev.Seq = s.seq
	switch ev.Kind {
	case EventStock:
		b := s.batches[ev.BatchID]
		if b == nil {
			b = &Batch{ID: ev.BatchID}
			s.batches[ev.BatchID] = b
			s.batchOrder = append(s.batchOrder, ev.BatchID)
		}
		b.Initial += ev.Quantity
		b.Available += ev.Quantity

	case EventReserve:
		s.gen++
		id := fmt.Sprintf("R%06d", s.gen)
		items := make(map[string]int, len(ev.Items))
		for batchID, qty := range ev.Items {
			items[batchID] = qty
			s.batches[batchID].Available -= qty
			s.batches[batchID].Reserved += qty
		}
		s.reservations[id] = &Reservation{
			ID:         id,
			RequestID:  ev.RequestID,
			Generation: s.gen,
			Items:      items,
			ExpireAt:   ev.ExpireAt,
			State:      Active,
			CreatedSeq: ev.Seq,
		}
		ev.ReservationID = id

	case EventConfirm:
		r := s.reservations[ev.ReservationID]
		if r == nil || r.State != Active {
			return fmt.Errorf("%w: confirm on %s", ErrLogCorrupt, ev.ReservationID)
		}
		for batchID, qty := range r.Items {
			b := s.batches[batchID]
			b.Reserved -= qty
			b.Confirmed += qty
		}
		r.State = Confirmed
		r.ClosedSeq = ev.Seq

	case EventCancel:
		r := s.reservations[ev.ReservationID]
		if r == nil || r.State != Active {
			return fmt.Errorf("%w: cancel on %s", ErrLogCorrupt, ev.ReservationID)
		}
		for batchID, qty := range r.Items {
			b := s.batches[batchID]
			b.Reserved -= qty
			b.Available += qty
		}
		r.State = Cancelled
		r.ClosedSeq = ev.Seq

	case EventExpire:
		r := s.reservations[ev.ReservationID]
		if r == nil || r.State != Active {
			return fmt.Errorf("%w: expire on %s", ErrLogCorrupt, ev.ReservationID)
		}
		for batchID, qty := range r.Items {
			b := s.batches[batchID]
			b.Reserved -= qty
			b.Available += qty
		}
		r.State = Expired
		r.ClosedSeq = ev.Seq

	default:
		return fmt.Errorf("%w: unknown event kind %q", ErrLogCorrupt, ev.Kind)
	}
	s.log = append(s.log, ev)
	return nil
}

// CheckConservation verifies per-batch inventory conservation:
// Initial == Available + Reserved + Confirmed, and Reserved equals the
// sum of holds of active reservations on that batch.
func (s *Store) CheckConservation() error {
	held := map[string]int{}
	for _, r := range s.reservations {
		if r.State != Active {
			continue
		}
		for batchID, qty := range r.Items {
			held[batchID] += qty
		}
	}
	for _, id := range s.batchOrder {
		b := s.batches[id]
		if b.Initial != b.Available+b.Reserved+b.Confirmed {
			return fmt.Errorf("batch %s: initial %d != available %d + reserved %d + confirmed %d",
				id, b.Initial, b.Available, b.Reserved, b.Confirmed)
		}
		if b.Reserved != held[id] {
			return fmt.Errorf("batch %s: reserved %d != active holds %d", id, b.Reserved, held[id])
		}
	}
	return nil
}

// Replay rebuilds a store from an event log, verifying per-batch
// conservation after every event.
func Replay(log []Event) (*Store, error) {
	s := NewStore()
	for _, ev := range log {
		if err := s.apply(ev); err != nil {
			return nil, err
		}
		if err := s.CheckConservation(); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrLogCorrupt, err)
		}
	}
	return s, nil
}

// Snapshot renders the full state canonically so live and replayed
// stores can be compared.
func (s *Store) Snapshot() string {
	var b strings.Builder
	for _, id := range s.batchOrder {
		bb := s.batches[id]
		fmt.Fprintf(&b, "batch %s init=%d avail=%d resv=%d conf=%d\n",
			id, bb.Initial, bb.Available, bb.Reserved, bb.Confirmed)
	}
	ids := make([]string, 0, len(s.reservations))
	for id := range s.reservations {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		r := s.reservations[id]
		fmt.Fprintf(&b, "rsv %s req=%s gen=%d state=%s items=%s expire=%d created=%d closed=%d\n",
			r.ID, r.RequestID, r.Generation, r.State, fingerprintItems(r.Items),
			r.ExpireAt.UnixNano(), r.CreatedSeq, r.ClosedSeq)
	}
	return b.String()
}

func fingerprintItems(items map[string]int) string {
	keys := make([]string, 0, len(items))
	for k := range items {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&b, "%s=%d;", k, items[k])
	}
	return b.String()
}
