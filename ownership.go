// Package ownership implements a two-phase ownership transfer protocol for
// named resources.
//
// A resource always has exactly one owner. Transferring ownership takes two
// phases: the current holder calls Prepare, which records a pending transfer
// to a designated recipient but leaves ownership with the holder; the
// recipient then calls Confirm, which atomically moves ownership. If the
// transfer is not confirmed before its deadline, it expires: the holder (or
// anyone) may Withdraw it, and a late Confirm is rejected.
//
// Every incarnation of a name carries a monotonically increasing generation
// number. A Ticket binds a name to one generation, so tickets captured before
// a name is removed and re-registered (name reuse) or before an ownership
// change are stale and rejected.
package ownership

import (
	"errors"
	"sync"
	"time"
)

var (
	ErrNotFound        = errors.New("ownership: resource not found")
	ErrAlreadyExists   = errors.New("ownership: resource already exists")
	ErrStaleTicket     = errors.New("ownership: stale ticket")
	ErrTransferPending = errors.New("ownership: transfer already pending")
	ErrNoTransfer      = errors.New("ownership: no such pending transfer")
	ErrTransferExpired = errors.New("ownership: transfer expired")
	ErrSelfTransfer    = errors.New("ownership: cannot transfer to current owner")
)

// Clock abstracts time so tests can control transfer expiry.
type Clock interface {
	Now() time.Time
}

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now() }

// Ticket is a capability naming one generation of a resource. It proves the
// bearer observed the current incarnation of the name; any ownership change,
// removal, or re-registration of the name invalidates it.
type Ticket struct {
	Name       string
	Generation uint64
}

// Registry tracks named resources and their owners. It is safe for
// concurrent use; every method is one atomic step under a single mutex.
type Registry struct {
	mu     sync.Mutex
	clock  Clock
	ttl    time.Duration
	nextID uint64
	res    map[string]*resource
	gens   map[string]uint64
}

type resource struct {
	owner   string
	pending *transfer
}

type transfer struct {
	id       uint64
	to       string
	deadline time.Time
}

// New returns a Registry using the system clock. ttl is how long a prepared
// transfer waits for Confirm before it expires.
func New(ttl time.Duration) *Registry {
	return NewWithClock(ttl, systemClock{})
}

// NewWithClock returns a Registry using the supplied clock.
func NewWithClock(ttl time.Duration, clock Clock) *Registry {
	return &Registry{
		clock: clock,
		ttl:   ttl,
		res:   make(map[string]*resource),
		gens:  make(map[string]uint64),
	}
}

// Register creates a resource owned by owner and returns its ticket. The
// generation counter for a name survives removal, so re-registering a
// previously used name yields a fresh generation.
func (r *Registry) Register(name, owner string) (Ticket, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.res[name]; ok {
		return Ticket{}, ErrAlreadyExists
	}
	r.gens[name]++
	r.res[name] = &resource{owner: owner}
	return Ticket{Name: name, Generation: r.gens[name]}, nil
}

// Remove deletes the resource identified by t. The name may later be
// re-registered under a new generation.
func (r *Registry) Remove(t Ticket) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, err := r.lookup(t); err != nil {
		return err
	}
	delete(r.res, t.Name)
	return nil
}

// Owner reports the current owner of name and a fresh ticket for it.
func (r *Registry) Owner(name string) (owner string, ticket Ticket, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	res, exists := r.res[name]
	if !exists {
		return "", Ticket{}, false
	}
	return res.owner, Ticket{Name: name, Generation: r.gens[name]}, true
}

// Pending reports whether a transfer of name is awaiting confirmation.
func (r *Registry) Pending(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	res, ok := r.res[name]
	return ok && res.pending != nil
}

// Prepare begins a transfer of the resource identified by t to recipient.
// Ownership stays with the current holder until Confirm succeeds. It returns
// the transfer ID the recipient must present to Confirm.
func (r *Registry) Prepare(t Ticket, recipient string) (uint64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	res, err := r.lookup(t)
	if err != nil {
		return 0, err
	}
	if res.pending != nil {
		return 0, ErrTransferPending
	}
	if res.owner == recipient {
		return 0, ErrSelfTransfer
	}
	r.nextID++
	id := r.nextID
	res.pending = &transfer{
		id:       id,
		to:       recipient,
		deadline: r.clock.Now().Add(r.ttl),
	}
	return id, nil
}

// Confirm atomically moves ownership of name to the designated recipient of
// transfer id. A confirm arriving after the transfer deadline is rejected
// and the expired transfer is discarded.
func (r *Registry) Confirm(name string, id uint64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	res, ok := r.res[name]
	if !ok {
		return ErrNotFound
	}
	p := res.pending
	if p == nil || p.id != id {
		return ErrNoTransfer
	}
	if !r.clock.Now().Before(p.deadline) {
		res.pending = nil
		return ErrTransferExpired
	}
	res.owner = p.to
	res.pending = nil
	r.gens[name]++ // ownership change invalidates the previous holder's ticket
	return nil
}

// Withdraw cancels the pending transfer id on name. The holder may withdraw
// at any time before Confirm; anyone may reap an expired transfer. Ownership
// is unchanged.
func (r *Registry) Withdraw(name string, id uint64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	res, ok := r.res[name]
	if !ok {
		return ErrNotFound
	}
	p := res.pending
	if p == nil || p.id != id {
		return ErrNoTransfer
	}
	res.pending = nil
	return nil
}

// lookup resolves a ticket to its resource, rejecting stale generations.
// Callers must hold r.mu.
func (r *Registry) lookup(t Ticket) (*resource, error) {
	res, ok := r.res[t.Name]
	if !ok {
		return nil, ErrNotFound
	}
	if r.gens[t.Name] != t.Generation {
		return nil, ErrStaleTicket
	}
	return res, nil
}
