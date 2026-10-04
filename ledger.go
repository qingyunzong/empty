// Package liability replays borrow, repay and reversal events ordered by
// (time, seq) to track an outstanding liability balance, and answers
// interval queries for the maximum liability and its earliest occurrence.
//
// Semantics:
//   - Events are applied in (Time, Seq) order regardless of insertion order.
//   - The balance starts at 0 and never goes negative.
//   - Borrow(a): a > 0; always effective, balance += a.
//   - Repay(a): effective iff 0 < a <= balance, then balance -= a;
//     an overpayment (a > balance) is illegal and has no effect.
//   - Reverse(target): effective iff target references an effective
//     Borrow/Repay that has not already been reversed. It applies the exact
//     inverse of the target: reversing a Repay(a) adds a back; reversing a
//     Borrow(a) subtracts a and is effective iff a <= balance (like a
//     repayment). Reversing a no-op event, an unknown seq, a reversal event,
//     or an event ordered after the reversal has no effect.
//   - Seq values must be unique; later duplicates are ignored.
//
// Queries use full replay: outstanding liability freely crosses query
// boundaries because the balance is rebuilt from the very first event.
package liability

import "sort"

// Kind identifies the type of an Event.
type Kind int

const (
	KindBorrow Kind = iota
	KindRepay
	KindReverse
)

// Event is a single borrow, repayment or reversal.
type Event struct {
	Seq    uint64 // unique sequence number; ties on Time break by Seq
	Time   int64  // event time (any monotonic integer clock)
	Kind   Kind
	Amount int64  // Borrow/Repay amount; unused for Reverse
	Target uint64 // Reverse only: Seq of the event to reverse
}

// Ledger accumulates events and answers liability queries.
type Ledger struct {
	events []Event
	sorted bool
}

// NewLedger returns an empty Ledger.
func NewLedger() *Ledger { return &Ledger{} }

// Add appends a single event.
func (l *Ledger) Add(ev Event) {
	l.events = append(l.events, ev)
	l.sorted = false
}

// AddBatch appends multiple events.
func (l *Ledger) AddBatch(evs []Event) {
	l.events = append(l.events, evs...)
	l.sorted = false
}

// ordered returns events sorted by (Time, Seq).
func (l *Ledger) ordered() []Event {
	if !l.sorted {
		sort.SliceStable(l.events, func(i, j int) bool {
			if l.events[i].Time != l.events[j].Time {
				return l.events[i].Time < l.events[j].Time
			}
			return l.events[i].Seq < l.events[j].Seq
		})
		l.sorted = true
	}
	return l.events
}

// effect records an effective Borrow/Repay so a later Reverse can undo it.
type effect struct {
	kind   Kind
	amount int64
}

// replay holds the mutable state of a full event replay.
type replay struct {
	balance  int64
	seen     map[uint64]bool   // every seq encountered (duplicates ignored)
	applied  map[uint64]effect // effective Borrow/Repay events
	reversed map[uint64]bool   // seqs already reversed
}

func newReplay() *replay {
	return &replay{
		seen:     make(map[uint64]bool),
		applied:  make(map[uint64]effect),
		reversed: make(map[uint64]bool),
	}
}

// apply folds one event into the replay state.
func (r *replay) apply(ev Event) {
	if r.seen[ev.Seq] {
		return
	}
	r.seen[ev.Seq] = true

	switch ev.Kind {
	case KindBorrow:
		if ev.Amount <= 0 {
			return
		}
		r.balance += ev.Amount
		r.applied[ev.Seq] = effect{kind: KindBorrow, amount: ev.Amount}

	case KindRepay:
		if ev.Amount <= 0 || ev.Amount > r.balance {
			return // illegal overpayment: no effect
		}
		r.balance -= ev.Amount
		r.applied[ev.Seq] = effect{kind: KindRepay, amount: ev.Amount}

	case KindReverse:
		eff, ok := r.applied[ev.Target]
		if !ok || r.reversed[ev.Target] {
			return
		}
		switch eff.kind {
		case KindBorrow:
			// Undoing a borrow subtracts its amount; like a repayment,
			// it is illegal when it exceeds the outstanding balance.
			if eff.amount > r.balance {
				return
			}
			r.balance -= eff.amount
		case KindRepay:
			r.balance += eff.amount
		}
		r.reversed[ev.Target] = true
	}
}

// MaxLiability returns the maximum liability balance observed within the
// half-open interval [from, to) and the earliest time at which that maximum
// is reached. The opening balance carried into the interval counts as a
// candidate at time `from`, so outstanding debt may span query boundaries.
// An empty interval (to <= from) yields (0, from).
func (l *Ledger) MaxLiability(from, to int64) (amount int64, at int64) {
	if to <= from {
		return 0, from
	}
	r := newReplay()
	best := int64(-1)
	bestTime := from
	for _, ev := range l.ordered() {
		if ev.Time >= to {
			break
		}
		if ev.Time >= from && best < 0 {
			best = r.balance // opening balance at `from`
		}
		r.apply(ev)
		if ev.Time >= from && r.balance > best {
			best, bestTime = r.balance, ev.Time
		}
	}
	if best < 0 {
		best = r.balance // no events inside [from, to): opening balance only
	}
	return best, bestTime
}

// BalanceAt returns the liability balance after applying every event with
// Time <= t.
func (l *Ledger) BalanceAt(t int64) int64 {
	r := newReplay()
	for _, ev := range l.ordered() {
		if ev.Time > t {
			break
		}
		r.apply(ev)
	}
	return r.balance
}
