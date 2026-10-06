package inventory

import (
	"sort"
	"time"
)

// UnitState is the lifecycle state of a single piece of stock.
type UnitState int

const (
	UnitOnHand UnitState = iota
	UnitConsumed
	UnitScrapped
)

// Unit is one individual piece of stock tracked by the reference model.
type Unit struct {
	ID      int
	BatchID string
	Expiry  time.Time
	State   UnitState
}

// UnitModel is a per-unit reference implementation used to cross-check
// the aggregate Ledger: every piece of stock is tracked individually.
type UnitModel struct {
	now     time.Time
	units   []*Unit
	batches map[string]time.Time // batch ID -> expiry
	frozen  map[string]bool
	nextID  int
}

func NewUnitModel(now time.Time) *UnitModel {
	return &UnitModel{
		now:     now,
		batches: make(map[string]time.Time),
		frozen:  make(map[string]bool),
	}
}

func (m *UnitModel) Receive(id string, qty int, expiry time.Time) {
	m.batches[id] = expiry
	for range qty {
		m.units = append(m.units, &Unit{
			ID:      m.nextID,
			BatchID: id,
			Expiry:  expiry,
			State:   UnitOnHand,
		})
		m.nextID++
	}
}

func (m *UnitModel) Freeze(id string)   { m.frozen[id] = true }
func (m *UnitModel) Unfreeze(id string) { m.frozen[id] = false }

func (m *UnitModel) AdvanceTo(t time.Time) {
	m.now = t
	m.retireExpired()
}

// Outbound mirrors Ledger.Outbound per unit; it reports whether the
// order was fully satisfied. On failure nothing changes.
func (m *UnitModel) Outbound(lines ...int) bool {
	m.retireExpired()
	var eligible []*Unit
	for _, u := range m.units {
		if u.State == UnitOnHand && !m.frozen[u.BatchID] && u.Expiry.After(m.now) {
			eligible = append(eligible, u)
		}
	}
	sort.Slice(eligible, func(i, j int) bool {
		a, b := eligible[i], eligible[j]
		if !a.Expiry.Equal(b.Expiry) {
			return a.Expiry.Before(b.Expiry)
		}
		if a.BatchID != b.BatchID {
			return a.BatchID < b.BatchID
		}
		return a.ID < b.ID
	})
	total := 0
	for _, q := range lines {
		total += q
	}
	if total > len(eligible) {
		return false
	}
	idx := 0
	for _, q := range lines {
		for ; q > 0; q-- {
			eligible[idx].State = UnitConsumed
			idx++
		}
	}
	return true
}

// Refund returns qty units to their original batch; if the batch is
// expired the units are scrapped immediately.
func (m *UnitModel) Refund(batchID string, qty int) {
	expiry := m.batches[batchID]
	state := UnitOnHand
	if !expiry.After(m.now) {
		state = UnitScrapped
	}
	for range qty {
		m.units = append(m.units, &Unit{
			ID:      m.nextID,
			BatchID: batchID,
			Expiry:  expiry,
			State:   state,
		})
		m.nextID++
	}
}

func (m *UnitModel) retireExpired() {
	for _, u := range m.units {
		if u.State == UnitOnHand && !u.Expiry.After(m.now) {
			u.State = UnitScrapped
		}
	}
}

// OnHandByBatch counts on-hand units per batch.
func (m *UnitModel) OnHandByBatch() map[string]int {
	out := make(map[string]int)
	for _, u := range m.units {
		if u.State == UnitOnHand {
			out[u.BatchID]++
		}
	}
	return out
}

// CountByState counts units in the given lifecycle state.
func (m *UnitModel) CountByState(s UnitState) int {
	n := 0
	for _, u := range m.units {
		if u.State == s {
			n++
		}
	}
	return n
}
