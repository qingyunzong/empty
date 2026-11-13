package dataeng

import (
	"sync"
	"time"
)

// State is the lifecycle state of a Reservation.
type State int

const (
	// Pending means the reservation holds budget and is not yet settled.
	Pending State = iota
	// Committed means the query succeeded and the cost is settled into the
	// ledger exactly once.
	Committed
	// Released means the reservation was cancelled; the held budget was
	// returned and nothing was settled.
	Released
	// Expired means the reservation timed out before settlement; the held
	// budget was returned and nothing was settled.
	Expired
)

func (s State) String() string {
	switch s {
	case Pending:
		return "pending"
	case Committed:
		return "committed"
	case Released:
		return "released"
	case Expired:
		return "expired"
	default:
		return "unknown"
	}
}

type hold struct {
	cost     Cost
	deadline time.Time // zero means no expiry
	res      *Reservation
}

type ledger struct {
	budget Budget
	spent  Cost
	holds  map[uint64]*hold
}

// Accountant tracks privacy budgets per Key. All methods are safe for
// concurrent use; budget adjudication (check + hold) is atomic under a
// single mutex, so concurrent requests can never overspend a ledger.
type Accountant struct {
	mu      sync.Mutex
	ledgers map[Key]*ledger
	nextID  uint64
	now     func() time.Time
}

// NewAccountant returns an empty Accountant.
func NewAccountant() *Accountant {
	return &Accountant{
		ledgers: make(map[Key]*ledger),
		now:     time.Now,
	}
}

// SetBudget configures (or replaces) the budget for a key. Replacing the
// budget does not affect already settled spend or pending holds.
func (a *Accountant) SetBudget(key Key, b Budget) error {
	if err := b.validate(); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	l := a.ledgers[key]
	if l == nil {
		l = &ledger{holds: make(map[uint64]*hold)}
		a.ledgers[key] = l
	}
	l.budget = b
	return nil
}

// expireLocked returns held budget for reservations past their deadline.
// The caller must hold a.mu.
func (a *Accountant) expireLocked(l *ledger) {
	now := a.now()
	for id, h := range l.holds {
		if !h.deadline.IsZero() && !now.Before(h.deadline) {
			delete(l.holds, id)
			h.res.state = Expired
		}
	}
}

// outstandingLocked composes settled spend with all live holds.
func (a *Accountant) outstandingLocked(l *ledger) Cost {
	total := l.spent.clone()
	for _, h := range l.holds {
		total = add(total, h.cost)
	}
	return total
}

// Reserve atomically checks the cost against the remaining budget and, if it
// fits, holds it as a pending reservation. A positive ttl makes the
// reservation expire after that duration; a zero ttl means no expiry.
// Reserve fails with ErrNoBudget if the key has no configured budget, and
// with ErrInsufficientBudget if the cost does not fit.
func (a *Accountant) Reserve(key Key, cost Cost, ttl time.Duration) (*Reservation, error) {
	if err := cost.validate(); err != nil {
		return nil, err
	}
	if ttl < 0 {
		ttl = 0
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	l, ok := a.ledgers[key]
	if !ok {
		return nil, ErrNoBudget
	}
	a.expireLocked(l)
	if !l.budget.fits(add(a.outstandingLocked(l), cost)) {
		return nil, ErrInsufficientBudget
	}
	a.nextID++
	res := &Reservation{acc: a, key: key, id: a.nextID, state: Pending}
	h := &hold{cost: cost.clone(), res: res}
	if ttl > 0 {
		h.deadline = a.now().Add(ttl)
	}
	l.holds[res.id] = h
	return res, nil
}

// Reservation is a pending budget hold. Exactly one of Commit, Release, or
// expiry settles it; later operations are no-ops or return an error, so a
// cost is never settled twice and a failed query never settles at all.
type Reservation struct {
	acc   *Accountant
	key   Key
	id    uint64
	state State // guarded by acc.mu
}

// State reports the current lifecycle state.
func (r *Reservation) State() State {
	r.acc.mu.Lock()
	defer r.acc.mu.Unlock()
	return r.state
}

// Commit settles the held cost into the ledger as published spend. It
// succeeds only while the reservation is pending and unexpired; after expiry
// it returns ErrReservationExpired, and after any settlement it returns
// ErrReservationClosed.
func (r *Reservation) Commit() error {
	a := r.acc
	a.mu.Lock()
	defer a.mu.Unlock()
	l := a.ledgers[r.key]
	a.expireLocked(l)
	switch r.state {
	case Committed, Released:
		return ErrReservationClosed
	case Expired:
		return ErrReservationExpired
	}
	h, ok := l.holds[r.id]
	if !ok {
		return ErrReservationClosed
	}
	l.spent = add(l.spent, h.cost)
	delete(l.holds, r.id)
	r.state = Committed
	return nil
}

// Release cancels the reservation and returns the held budget. It is a no-op
// if the reservation was already settled or expired, so cancel/timeout races
// can never double-settle or double-free.
func (r *Reservation) Release() {
	a := r.acc
	a.mu.Lock()
	defer a.mu.Unlock()
	if r.state != Pending {
		return
	}
	if l, ok := a.ledgers[r.key]; ok {
		delete(l.holds, r.id)
	}
	r.state = Released
}

// Spent returns a copy of the settled (published) cost for a key. Pending
// holds are not included.
func (a *Accountant) Spent(key Key) Cost {
	a.mu.Lock()
	defer a.mu.Unlock()
	if l, ok := a.ledgers[key]; ok {
		return l.spent.clone()
	}
	return Cost{}
}

// Held returns a copy of the cost currently held by pending, unexpired
// reservations for a key.
func (a *Accountant) Held(key Key) Cost {
	a.mu.Lock()
	defer a.mu.Unlock()
	l, ok := a.ledgers[key]
	if !ok {
		return Cost{}
	}
	a.expireLocked(l)
	total := Cost{}
	for _, h := range l.holds {
		total = add(total, h.cost)
	}
	return total
}

// Remaining returns the budget still available for new reservations:
// configured budget minus settled spend and live holds, per dimension. RDP
// orders present in the budget are reported; orders without a configured cap
// are omitted.
func (a *Accountant) Remaining(key Key) (Budget, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	l, ok := a.ledgers[key]
	if !ok {
		return Budget{}, ErrNoBudget
	}
	a.expireLocked(l)
	used := a.outstandingLocked(l)
	rem := Budget{
		Epsilon: l.budget.Epsilon - used.Epsilon,
		Delta:   l.budget.Delta - used.Delta,
	}
	if len(l.budget.RDP) > 0 {
		rem.RDP = make(map[float64]float64, len(l.budget.RDP))
		for alpha, cap := range l.budget.RDP {
			rem.RDP[alpha] = cap - used.RDP[alpha]
		}
	}
	return rem, nil
}

// PublishedEpsilon converts the settled spend of a key into an overall
// (epsilon, delta) guarantee at the given target delta. The pure DP part
// composes additively, and the RDP part is converted with the tightest bound
// across all recorded orders; the returned delta is the sum of the settled
// pure delta and the target delta used for the RDP conversion.
func (a *Accountant) PublishedEpsilon(key Key, delta float64) (epsilon, totalDelta float64, err error) {
	a.mu.Lock()
	spent := Cost{}
	if l, ok := a.ledgers[key]; ok {
		spent = l.spent.clone()
	}
	a.mu.Unlock()
	epsilon = spent.Epsilon
	if len(spent.RDP) > 0 {
		rdpEps, err := EpsilonForDelta(spent.RDP, delta)
		if err != nil {
			return 0, 0, err
		}
		epsilon += rdpEps
	} else if delta <= 0 || delta >= 1 {
		return 0, 0, ErrInvalidCost
	}
	return epsilon, spent.Delta + delta, nil
}
