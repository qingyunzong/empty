// Package inventory implements a batch-based stock ledger with FEFO
// allocation, expiry retirement, QC freezes, atomic orders and refunds.
package inventory

import (
	"errors"
	"fmt"
	"sort"
	"time"
)

// ErrInsufficientStock is returned when an order cannot be fully satisfied;
// in that case nothing is consumed at all.
var ErrInsufficientStock = errors.New("insufficient stock for order")

// Batch is a quantity of stock sharing an expiry time.
type Batch struct {
	ID     string
	Expiry time.Time
	OnHand int
	Frozen bool // QC-frozen batches do not participate in consumption
}

// Totals summarizes ledger-wide counters for account verification.
type Totals struct {
	Received int
	Consumed int
	Scrapped int
	Refunded int
	OnHand   int
}

// Ledger tracks batches at aggregate (quantity) level.
type Ledger struct {
	now      time.Time
	batches  map[string]*Batch
	received int
	consumed int
	scrapped int
	refunded int
}

func NewLedger(now time.Time) *Ledger {
	return &Ledger{now: now, batches: make(map[string]*Batch)}
}

func (l *Ledger) Now() time.Time { return l.now }

// Receive adds qty units under batch id with the given expiry.
func (l *Ledger) Receive(id string, qty int, expiry time.Time) error {
	if qty <= 0 {
		return fmt.Errorf("receive quantity must be positive: %d", qty)
	}
	if b, ok := l.batches[id]; ok {
		if !b.Expiry.Equal(expiry) {
			return fmt.Errorf("batch %q already exists with expiry %s", id, b.Expiry)
		}
		b.OnHand += qty
	} else {
		l.batches[id] = &Batch{ID: id, Expiry: expiry, OnHand: qty}
	}
	l.received += qty
	return nil
}

// Freeze marks a batch as QC-frozen so it is skipped during allocation.
func (l *Ledger) Freeze(id string) error {
	b, ok := l.batches[id]
	if !ok {
		return fmt.Errorf("unknown batch %q", id)
	}
	b.Frozen = true
	return nil
}

// Unfreeze releases a QC freeze.
func (l *Ledger) Unfreeze(id string) error {
	b, ok := l.batches[id]
	if !ok {
		return fmt.Errorf("unknown batch %q", id)
	}
	b.Frozen = false
	return nil
}

// AdvanceTo moves the clock forward and retires expired stock into scrap.
func (l *Ledger) AdvanceTo(t time.Time) error {
	if t.Before(l.now) {
		return fmt.Errorf("cannot move time backwards: %s < %s", t, l.now)
	}
	l.now = t
	l.retireExpired()
	return nil
}

// Outbound consumes one order atomically: expired stock is retired first,
// then every line is allocated FEFO (earliest expiry, then batch ID).
// If any line cannot be fully satisfied, nothing is consumed.
func (l *Ledger) Outbound(lines ...int) error {
	for _, q := range lines {
		if q <= 0 {
			return fmt.Errorf("line quantity must be positive: %d", q)
		}
	}
	l.retireExpired()
	cands := l.allocatable()
	remaining := make(map[string]int, len(cands))
	for _, b := range cands {
		remaining[b.ID] = b.OnHand
	}
	for _, q := range lines {
		for _, b := range cands {
			if q == 0 {
				break
			}
			take := min(remaining[b.ID], q)
			remaining[b.ID] -= take
			q -= take
		}
		if q > 0 {
			return ErrInsufficientStock
		}
	}
	for _, b := range cands {
		taken := b.OnHand - remaining[b.ID]
		b.OnHand = remaining[b.ID]
		l.consumed += taken
	}
	return nil
}

// Refund returns qty units to their original batch. If that batch is
// already expired, the refunded units go straight to scrap.
func (l *Ledger) Refund(batchID string, qty int) error {
	if qty <= 0 {
		return fmt.Errorf("refund quantity must be positive: %d", qty)
	}
	b, ok := l.batches[batchID]
	if !ok {
		return fmt.Errorf("unknown batch %q", batchID)
	}
	l.refunded += qty
	if l.expired(b) {
		l.scrapped += qty
	} else {
		b.OnHand += qty
	}
	return nil
}

// OnHandOf reports the on-hand quantity of a batch (0 if unknown).
func (l *Ledger) OnHandOf(id string) int {
	if b, ok := l.batches[id]; ok {
		return b.OnHand
	}
	return 0
}

// Batches returns a snapshot of all batches sorted by ID.
func (l *Ledger) Batches() []Batch {
	out := make([]Batch, 0, len(l.batches))
	for _, b := range l.batches {
		out = append(out, *b)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Totals returns the ledger-wide counters.
func (l *Ledger) Totals() Totals {
	t := Totals{
		Received: l.received,
		Consumed: l.consumed,
		Scrapped: l.scrapped,
		Refunded: l.refunded,
	}
	for _, b := range l.batches {
		t.OnHand += b.OnHand
	}
	return t
}

func (l *Ledger) expired(b *Batch) bool { return !b.Expiry.After(l.now) }

// retireExpired moves remaining stock of expired batches into scrap.
func (l *Ledger) retireExpired() {
	for _, b := range l.batches {
		if b.OnHand > 0 && l.expired(b) {
			l.scrapped += b.OnHand
			b.OnHand = 0
		}
	}
}

// allocatable lists consumable batches in FEFO order:
// earliest expiry first, ties broken by batch ID.
func (l *Ledger) allocatable() []*Batch {
	var out []*Batch
	for _, b := range l.batches {
		if b.OnHand > 0 && !b.Frozen && !l.expired(b) {
			out = append(out, b)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Expiry.Equal(out[j].Expiry) {
			return out[i].Expiry.Before(out[j].Expiry)
		}
		return out[i].ID < out[j].ID
	})
	return out
}
