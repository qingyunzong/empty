// Package fefo implements a fulfilment inventory ledger that allocates
// batches by earliest expiry first (FEFO), restores customer returns only
// into unexpired original batches (expired stock is scrapped), and supports
// event corrections by replaying the amended event log from scratch.
package fefo

import (
	"errors"
	"fmt"
	"sort"
	"time"
)

// Event is a single entry in the warehouse event log. Dates use the
// ISO-8601 form "2006-01-02" so they compare lexicographically.
type Event interface {
	EventID() string
	EventDate() string
}

// Receipt records inbound stock for one batch with a fixed expiry date.
type Receipt struct {
	ID     string
	Date   string
	Batch  string
	Qty    int
	Expiry string
}

func (r *Receipt) EventID() string   { return r.ID }
func (r *Receipt) EventDate() string { return r.Date }

// Order requests stock to be shipped; allocation is FEFO across batches
// that are unexpired on the order date.
type Order struct {
	ID   string
	Date string
	Qty  int
}

func (o *Order) EventID() string   { return o.ID }
func (o *Order) EventDate() string { return o.Date }

// Return brings previously shipped quantity of an order back. Stock is
// restored into the original source batches (reverse allocation order)
// while those batches are unexpired on the return date; the expired
// remainder is scrapped.
type Return struct {
	ID      string
	Date    string
	OrderID string
	Qty     int
}

func (r *Return) EventID() string   { return r.ID }
func (r *Return) EventDate() string { return r.Date }

// Amend corrects a previously logged event. The replacement keeps the
// target's ID and original position in the log; a nil replacement voids
// the target. Amendments only take effect through Replay.
type Amend struct {
	ID          string
	Date        string
	TargetID    string
	Replacement Event
}

func (a *Amend) EventID() string   { return a.ID }
func (a *Amend) EventDate() string { return a.Date }

// Allocation is one batch-level source line of an order.
type Allocation struct {
	Batch    string
	Expiry   string
	Qty      int
	Returned int
}

// OrderState is the replayed outcome of one order.
type OrderState struct {
	ID          string
	Date        string
	Requested   int
	Shipped     int
	Shortage    int
	Returned    int
	Allocations []Allocation
}

// BatchState is the replayed state of one batch.
type BatchState struct {
	ID        string
	Expiry    string
	Received  int
	Remaining int
	Scrapped  int
}

// DayLedger is the aggregate stock flow of one calendar day. On-hand only
// changes through Received, Shipped, Restocked and Scrapped; expired
// returns (ReturnScrapped) never touch the shelf because the stock left it
// when the order shipped.
type DayLedger struct {
	Date           string
	Received       int
	Shipped        int
	Returned       int // quantity handed back by customers
	Restocked      int // returned quantity put back into unexpired batches
	Scrapped       int // shelf stock written off on expiry
	ReturnScrapped int // returned quantity scrapped (source batch expired)
	OnHand         int // sum of batch Remaining at end of day
}

// State is the full result of replaying an event log.
type State struct {
	Batches   map[string]*BatchState
	Orders    map[string]*OrderState
	Ledger    []DayLedger
	Scrapped  int
	validated bool
}

func validDate(d string) bool {
	_, err := time.Parse("2006-01-02", d)
	return err == nil
}

// EffectiveLog applies every Amend in the log and returns the remaining
// events in their original order. A correction replaces its target in
// place, so replaying the effective log reproduces history as corrected.
func EffectiveLog(log []Event) ([]Event, error) {
	events := make([]Event, 0, len(log))
	index := make(map[string]int, len(log))
	for _, ev := range log {
		if ev == nil {
			return nil, errors.New("fefo: nil event in log")
		}
		id := ev.EventID()
		if id == "" {
			return nil, errors.New("fefo: event with empty ID")
		}
		if _, dup := index[id]; dup {
			return nil, fmt.Errorf("fefo: duplicate event ID %q", id)
		}
		if a, ok := ev.(*Amend); ok {
			pos, found := index[a.TargetID]
			if !found {
				return nil, fmt.Errorf("fefo: amend %q targets unknown event %q", a.ID, a.TargetID)
			}
			if a.Replacement == nil {
				events[pos] = nil
				continue
			}
			if a.Replacement.EventID() != a.TargetID {
				return nil, fmt.Errorf("fefo: amend %q replacement ID %q must equal target ID %q", a.ID, a.Replacement.EventID(), a.TargetID)
			}
			if _, isAmend := a.Replacement.(*Amend); isAmend {
				return nil, fmt.Errorf("fefo: amend %q cannot replace with another amend", a.ID)
			}
			events[pos] = a.Replacement
			index[id] = -1 // register the amend ID as used
			continue
		}
		index[id] = len(events)
		events = append(events, ev)
	}
	out := events[:0]
	for _, ev := range events {
		if ev != nil {
			out = append(out, ev)
		}
	}
	return out, nil
}

// Replay folds the (corrected) event log into a State. Events are applied
// in chronological order; before each new date is processed, batches whose
// expiry is earlier than that date are written off to scrap.
func Replay(log []Event) (*State, error) {
	events, err := EffectiveLog(log)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(events, func(i, j int) bool {
		return events[i].EventDate() < events[j].EventDate()
	})

	s := &State{
		Batches: make(map[string]*BatchState),
		Orders:  make(map[string]*OrderState),
	}
	day := DayLedger{}
	open := false
	flush := func() {
		if !open {
			return
		}
		onHand := 0
		for _, b := range s.Batches {
			onHand += b.Remaining
		}
		day.OnHand = onHand
		s.Ledger = append(s.Ledger, day)
		open = false
	}

	for _, ev := range events {
		d := ev.EventDate()
		if !validDate(d) {
			return nil, fmt.Errorf("fefo: event %q has invalid date %q", ev.EventID(), d)
		}
		if !open || d != day.Date {
			flush()
			day = DayLedger{Date: d}
			open = true
			s.scrapExpiredBefore(d, &day)
		}
		var err error
		switch e := ev.(type) {
		case *Receipt:
			err = s.receive(e, &day)
		case *Order:
			err = s.ship(e, &day)
		case *Return:
			err = s.restock(e, &day)
		default:
			err = fmt.Errorf("fefo: unsupported event type %T", ev)
		}
		if err != nil {
			return nil, err
		}
	}
	flush()
	return s, nil
}

// scrapExpiredBefore moves stock of batches expired strictly before date d
// into scrap. A batch is sellable through its expiry date inclusive.
func (s *State) scrapExpiredBefore(d string, day *DayLedger) {
	for _, b := range s.Batches {
		if b.Remaining > 0 && b.Expiry < d {
			day.Scrapped += b.Remaining
			s.Scrapped += b.Remaining
			b.Scrapped += b.Remaining
			b.Remaining = 0
		}
	}
}

func (s *State) receive(r *Receipt, day *DayLedger) error {
	if r.Qty <= 0 {
		return fmt.Errorf("fefo: receipt %q has non-positive qty %d", r.ID, r.Qty)
	}
	if !validDate(r.Expiry) {
		return fmt.Errorf("fefo: receipt %q has invalid expiry %q", r.ID, r.Expiry)
	}
	if r.Expiry < r.Date {
		return fmt.Errorf("fefo: receipt %q expires %q before its date %q", r.ID, r.Expiry, r.Date)
	}
	if _, exists := s.Batches[r.Batch]; exists {
		return fmt.Errorf("fefo: receipt %q duplicates batch %q", r.ID, r.Batch)
	}
	s.Batches[r.Batch] = &BatchState{ID: r.Batch, Expiry: r.Expiry, Received: r.Qty, Remaining: r.Qty}
	day.Received += r.Qty
	return nil
}

// fefo lists batches with stock, earliest expiry first, batch ID as tiebreak.
func (s *State) fefo() []*BatchState {
	batches := make([]*BatchState, 0, len(s.Batches))
	for _, b := range s.Batches {
		if b.Remaining > 0 {
			batches = append(batches, b)
		}
	}
	sort.Slice(batches, func(i, j int) bool {
		if batches[i].Expiry != batches[j].Expiry {
			return batches[i].Expiry < batches[j].Expiry
		}
		return batches[i].ID < batches[j].ID
	})
	return batches
}

func (s *State) ship(o *Order, day *DayLedger) error {
	if o.Qty <= 0 {
		return fmt.Errorf("fefo: order %q has non-positive qty %d", o.ID, o.Qty)
	}
	if _, exists := s.Orders[o.ID]; exists {
		return fmt.Errorf("fefo: duplicate order %q", o.ID)
	}
	os := &OrderState{ID: o.ID, Date: o.Date, Requested: o.Qty}
	need := o.Qty
	for _, b := range s.fefo() {
		if need == 0 {
			break
		}
		take := b.Remaining
		if take > need {
			take = need
		}
		b.Remaining -= take
		os.Allocations = append(os.Allocations, Allocation{Batch: b.ID, Expiry: b.Expiry, Qty: take})
		os.Shipped += take
		need -= take
	}
	os.Shortage = need
	day.Shipped += os.Shipped
	s.Orders[o.ID] = os
	return nil
}

// restock returns quantity into the order's original source batches in
// reverse allocation order. Portions whose source batch is already expired
// on the return date are scrapped instead of restocked.
func (s *State) restock(r *Return, day *DayLedger) error {
	if r.Qty <= 0 {
		return fmt.Errorf("fefo: return %q has non-positive qty %d", r.ID, r.Qty)
	}
	os, exists := s.Orders[r.OrderID]
	if !exists {
		return fmt.Errorf("fefo: return %q references unknown order %q", r.ID, r.OrderID)
	}
	if os.Returned+r.Qty > os.Shipped {
		return fmt.Errorf("fefo: return %q of %d exceeds returnable qty %d for order %q", r.ID, r.Qty, os.Shipped-os.Returned, r.OrderID)
	}
	os.Returned += r.Qty
	day.Returned += r.Qty
	left := r.Qty
	for i := len(os.Allocations) - 1; i >= 0 && left > 0; i-- {
		a := &os.Allocations[i]
		avail := a.Qty - a.Returned
		if avail == 0 {
			continue
		}
		take := avail
		if take > left {
			take = left
		}
		a.Returned += take
		left -= take
		b := s.Batches[a.Batch]
		if b.Expiry >= r.Date {
			b.Remaining += take
			day.Restocked += take
		} else {
			b.Scrapped += take
			s.Scrapped += take
			day.ReturnScrapped += take
		}
	}
	return nil
}

// CheckConservation verifies the global stock identity
//
//	received == onHand + (shipped - returned) + scrapped
//
// and that every daily ledger balances against the previous day's on-hand.
func (s *State) CheckConservation() error {
	received, onHand := 0, 0
	for _, b := range s.Batches {
		received += b.Received
		onHand += b.Remaining
	}
	shipped, returned := 0, 0
	for _, o := range s.Orders {
		shipped += o.Shipped
		returned += o.Returned
	}
	if want := onHand + shipped - returned + s.Scrapped; received != want {
		return fmt.Errorf("fefo: conservation violated: received %d != onHand %d + netShipped %d + scrapped %d (= %d)",
			received, onHand, shipped-returned, s.Scrapped, want)
	}
	prev := 0
	for _, d := range s.Ledger {
		if got := prev + d.Received - d.Shipped + d.Restocked - d.Scrapped; got != d.OnHand {
			return fmt.Errorf("fefo: day %s unbalanced: %d + %d - %d + %d - %d = %d != onHand %d",
				d.Date, prev, d.Received, d.Shipped, d.Restocked, d.Scrapped, got, d.OnHand)
		}
		prev = d.OnHand
	}
	if prev != onHand {
		return fmt.Errorf("fefo: ledger final onHand %d != batch-level onHand %d", prev, onHand)
	}
	return nil
}

// Sources returns the batch-level source lines of an order.
func (s *State) Sources(orderID string) ([]Allocation, bool) {
	o, ok := s.Orders[orderID]
	if !ok {
		return nil, false
	}
	out := make([]Allocation, len(o.Allocations))
	copy(out, o.Allocations)
	return out, true
}
