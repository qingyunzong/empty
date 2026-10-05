// Package inventory implements batch stock reservations with event-ordered
// expiry, confirmation and cancellation.
//
// Semantics:
//   - A reservation spans stock lines across multiple batches.
//   - Expiry, confirm and cancel race by event order: commands are applied
//     in log order; before each command at time T, active reservations with
//     Deadline <= T expire (the deadline moment itself is included).
//   - Confirm transfers the whole line set in one shot (all or nothing).
//   - Request IDs bind parameters: replaying a request ID with identical
//     parameters returns the recorded result; different parameters conflict.
//   - Re-acquiring a key after expiry/cancel yields a new generation.
//   - The event log can be replayed and checked for per-batch conservation.
package inventory

import (
	"errors"
	"fmt"
	"sort"
)

var (
	ErrRequestConflict      = errors.New("inventory: request ID bound to different parameters")
	ErrUnknownBatch         = errors.New("inventory: unknown batch")
	ErrInsufficientStock    = errors.New("inventory: insufficient available stock")
	ErrReservationNotFound  = errors.New("inventory: reservation not found")
	ErrReservationNotActive = errors.New("inventory: reservation not active")
	ErrKeyAlreadyReserved   = errors.New("inventory: key already has an active reservation")
	ErrInvalidQuantity      = errors.New("inventory: line quantity must be positive")
)

// Line is a quantity of one batch held by a reservation.
type Line struct {
	Batch string
	Qty   int64
}

// State is the lifecycle state of a reservation.
type State string

const (
	Active    State = "active"
	Confirmed State = "confirmed"
	Cancelled State = "cancelled"
	Expired   State = "expired"
)

// Reservation is a hold on stock lines across batches.
type Reservation struct {
	ID         string
	Key        string
	Generation int
	Lines      []Line
	Deadline   int64
	State      State
}

// Event kinds recorded in the store log.
const (
	EventReserve = "reserve"
	EventConfirm = "confirm"
	EventCancel  = "cancel"
	EventExpire  = "expire"
)

// Event is one applied mutation, in log order.
type Event struct {
	Seq           int64
	Time          int64
	Kind          string
	RequestID     string
	ReservationID string
	Key           string
	Generation    int
	Lines         []Line
	Deadline      int64
}

type batch struct {
	total    int64
	reserved int64
	consumed int64
}

func (b *batch) available() int64 { return b.total - b.reserved - b.consumed }

type requestRecord struct {
	fingerprint string
	result      string // reservation ID for reserve, "" otherwise
	err         error
}

// Store holds batch stock, reservations, the request log and the event log.
type Store struct {
	batches      map[string]*batch
	reservations map[string]*Reservation
	order        []string // reservation IDs in creation order
	activeByKey  map[string]string
	generations  map[string]int
	requests     map[string]requestRecord
	events       []Event
	replaying    bool
}

// NewStore creates a store with the given initial stock per batch.
func NewStore(initial map[string]int64) *Store {
	s := &Store{
		batches:      make(map[string]*batch),
		reservations: make(map[string]*Reservation),
		activeByKey:  make(map[string]string),
		generations:  make(map[string]int),
		requests:     make(map[string]requestRecord),
	}
	for name, qty := range initial {
		s.batches[name] = &batch{total: qty}
	}
	return s
}

// Events returns the applied event log in order.
func (s *Store) Events() []Event {
	out := make([]Event, len(s.events))
	copy(out, s.events)
	return out
}

// Reservation returns a copy of the reservation with the given ID.
func (s *Store) Reservation(id string) (Reservation, bool) {
	r, ok := s.reservations[id]
	if !ok {
		return Reservation{}, false
	}
	cp := *r
	cp.Lines = append([]Line(nil), r.Lines...)
	return cp, true
}

// BatchLevel reports total, reserved, consumed and available for a batch.
func (s *Store) BatchLevel(name string) (total, reserved, consumed, available int64, ok bool) {
	b, ok := s.batches[name]
	if !ok {
		return 0, 0, 0, 0, false
	}
	return b.total, b.reserved, b.consumed, b.available(), true
}

func (s *Store) appendEvent(e Event) {
	if s.replaying {
		return
	}
	e.Seq = int64(len(s.events)) + 1
	s.events = append(s.events, e)
}

// expire releases every active reservation whose deadline has passed.
// The deadline moment itself counts as expired: Deadline <= now.
func (s *Store) expire(now int64) {
	for _, id := range s.order {
		r := s.reservations[id]
		if r.State != Active || r.Deadline > now {
			continue
		}
		s.release(r)
		r.State = Expired
		delete(s.activeByKey, r.Key)
		s.appendEvent(Event{
			Time:          now,
			Kind:          EventExpire,
			ReservationID: r.ID,
			Key:           r.Key,
			Generation:    r.Generation,
		})
	}
}

func (s *Store) release(r *Reservation) {
	for _, ln := range r.Lines {
		s.batches[ln.Batch].reserved -= ln.Qty
	}
}

// checkRequest enforces request-ID parameter binding. It returns the
// recorded result when the request was already applied with identical
// parameters.
func (s *Store) checkRequest(requestID, fingerprint string) (requestRecord, bool, error) {
	rec, seen := s.requests[requestID]
	if !seen {
		return requestRecord{}, false, nil
	}
	if rec.fingerprint != fingerprint {
		return requestRecord{}, false, ErrRequestConflict
	}
	return rec, true, nil
}

func (s *Store) recordRequest(requestID, fingerprint, result string, err error) {
	s.requests[requestID] = requestRecord{fingerprint: fingerprint, result: result, err: err}
}

func fingerprintReserve(key string, lines []Line, deadline int64) string {
	sorted := append([]Line(nil), lines...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Batch < sorted[j].Batch })
	fp := fmt.Sprintf("reserve|%s|%d|", key, deadline)
	for _, ln := range sorted {
		fp += fmt.Sprintf("%s:%d;", ln.Batch, ln.Qty)
	}
	return fp
}

// Reserve holds lines across batches under a logical key. Re-reserving a
// key after its previous reservation expired or was cancelled yields a new
// generation. The reservation expires when now >= deadline.
func (s *Store) Reserve(now int64, requestID, key string, lines []Line, deadline int64) (Reservation, error) {
	s.expire(now)
	fp := fingerprintReserve(key, lines, deadline)
	if rec, seen, err := s.checkRequest(requestID, fp); err != nil {
		return Reservation{}, err
	} else if seen {
		r, _ := s.Reservation(rec.result)
		return r, rec.err
	}

	res, err := s.applyReserve(now, requestID, key, lines, deadline)
	result := ""
	if err == nil {
		result = res.ID
	}
	s.recordRequest(requestID, fp, result, err)
	return res, err
}

func (s *Store) applyReserve(now int64, requestID, key string, lines []Line, deadline int64) (Reservation, error) {
	if len(lines) == 0 {
		return Reservation{}, ErrInvalidQuantity
	}
	if _, ok := s.activeByKey[key]; ok {
		return Reservation{}, ErrKeyAlreadyReserved
	}
	for _, ln := range lines {
		if ln.Qty <= 0 {
			return Reservation{}, ErrInvalidQuantity
		}
		b, ok := s.batches[ln.Batch]
		if !ok {
			return Reservation{}, ErrUnknownBatch
		}
		if b.available() < ln.Qty {
			return Reservation{}, ErrInsufficientStock
		}
	}
	s.generations[key]++
	gen := s.generations[key]
	r := &Reservation{
		ID:         fmt.Sprintf("%s#%d", key, gen),
		Key:        key,
		Generation: gen,
		Lines:      append([]Line(nil), lines...),
		Deadline:   deadline,
		State:      Active,
	}
	for _, ln := range lines {
		s.batches[ln.Batch].reserved += ln.Qty
	}
	s.reservations[r.ID] = r
	s.order = append(s.order, r.ID)
	s.activeByKey[key] = r.ID
	s.appendEvent(Event{
		Time:          now,
		Kind:          EventReserve,
		RequestID:     requestID,
		ReservationID: r.ID,
		Key:           key,
		Generation:    gen,
		Lines:         append([]Line(nil), lines...),
		Deadline:      deadline,
	})
	return *r, nil
}

// Confirm transfers the reservation's whole line set from reserved to
// consumed in one shot. It loses the race if expiry or cancellation was
// already applied.
func (s *Store) Confirm(now int64, requestID, reservationID string) error {
	s.expire(now)
	fp := "confirm|" + reservationID
	if rec, seen, err := s.checkRequest(requestID, fp); err != nil {
		return err
	} else if seen {
		return rec.err
	}
	err := s.applyConfirm(now, requestID, reservationID)
	s.recordRequest(requestID, fp, "", err)
	return err
}

func (s *Store) applyConfirm(now int64, requestID, reservationID string) error {
	r, ok := s.reservations[reservationID]
	if !ok {
		return ErrReservationNotFound
	}
	if r.State != Active {
		return ErrReservationNotActive
	}
	for _, ln := range r.Lines {
		b := s.batches[ln.Batch]
		b.reserved -= ln.Qty
		b.consumed += ln.Qty
	}
	r.State = Confirmed
	delete(s.activeByKey, r.Key)
	s.appendEvent(Event{
		Time:          now,
		Kind:          EventConfirm,
		RequestID:     requestID,
		ReservationID: r.ID,
		Key:           r.Key,
		Generation:    r.Generation,
	})
	return nil
}

// Cancel releases the reservation's holds. It loses the race if expiry or
// confirmation was already applied.
func (s *Store) Cancel(now int64, requestID, reservationID string) error {
	s.expire(now)
	fp := "cancel|" + reservationID
	if rec, seen, err := s.checkRequest(requestID, fp); err != nil {
		return err
	} else if seen {
		return rec.err
	}
	err := s.applyCancel(now, requestID, reservationID)
	s.recordRequest(requestID, fp, "", err)
	return err
}

func (s *Store) applyCancel(now int64, requestID, reservationID string) error {
	r, ok := s.reservations[reservationID]
	if !ok {
		return ErrReservationNotFound
	}
	if r.State != Active {
		return ErrReservationNotActive
	}
	s.release(r)
	r.State = Cancelled
	delete(s.activeByKey, r.Key)
	s.appendEvent(Event{
		Time:          now,
		Kind:          EventCancel,
		RequestID:     requestID,
		ReservationID: r.ID,
		Key:           r.Key,
		Generation:    r.Generation,
	})
	return nil
}

// Verify checks per-batch inventory conservation: reserved and consumed
// are non-negative, reserved+consumed never exceeds total, and the sum of
// active reservation holds per batch equals the reserved counter.
func (s *Store) Verify() error {
	held := make(map[string]int64)
	for _, r := range s.reservations {
		if r.State != Active {
			continue
		}
		for _, ln := range r.Lines {
			held[ln.Batch] += ln.Qty
		}
	}
	for name, b := range s.batches {
		if b.reserved < 0 || b.consumed < 0 {
			return fmt.Errorf("inventory: batch %s has negative counters", name)
		}
		if b.reserved+b.consumed > b.total {
			return fmt.Errorf("inventory: batch %s over-committed: reserved %d + consumed %d > total %d",
				name, b.reserved, b.consumed, b.total)
		}
		if held[name] != b.reserved {
			return fmt.Errorf("inventory: batch %s reserved %d != active holds %d",
				name, b.reserved, held[name])
		}
	}
	return nil
}

// Replay rebuilds a store from initial stock and an event log, applying
// events in log order. The result can be compared against the live store
// and checked with Verify.
func Replay(initial map[string]int64, events []Event) (*Store, error) {
	s := NewStore(initial)
	s.replaying = true
	for _, e := range events {
		switch e.Kind {
		case EventReserve:
			if _, err := s.applyReserve(e.Time, e.RequestID, e.Key, e.Lines, e.Deadline); err != nil {
				return nil, fmt.Errorf("inventory: replay event %d: %w", e.Seq, err)
			}
		case EventConfirm:
			if err := s.applyConfirm(e.Time, e.RequestID, e.ReservationID); err != nil {
				return nil, fmt.Errorf("inventory: replay event %d: %w", e.Seq, err)
			}
		case EventCancel:
			if err := s.applyCancel(e.Time, e.RequestID, e.ReservationID); err != nil {
				return nil, fmt.Errorf("inventory: replay event %d: %w", e.Seq, err)
			}
		case EventExpire:
			r, ok := s.reservations[e.ReservationID]
			if !ok {
				return nil, fmt.Errorf("inventory: replay event %d: %w", e.Seq, ErrReservationNotFound)
			}
			if r.State != Active {
				return nil, fmt.Errorf("inventory: replay event %d: %w", e.Seq, ErrReservationNotActive)
			}
			s.release(r)
			r.State = Expired
			delete(s.activeByKey, r.Key)
		default:
			return nil, fmt.Errorf("inventory: replay event %d: unknown kind %q", e.Seq, e.Kind)
		}
	}
	s.replaying = false
	s.events = append([]Event(nil), events...)
	return s, nil
}
