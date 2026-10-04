// Package ownership implements a two-phase ownership transfer registry.
//
// A resource is identified by name. Because names can be reused after a
// resource is released, every resource carries a monotonically increasing
// generation; a Ticket (name + generation) unambiguously identifies one
// incarnation of a resource, so stale holders of a reused name cannot
// operate on the new incarnation.
//
// Transfer protocol:
//   - Prepare: the current holder declares an intent to transfer to a
//     designated recipient before a deadline. Ownership does NOT change
//     during the prepare phase; the original holder still owns the resource.
//   - Confirm: before the deadline, atomically moves ownership to the
//     recipient and bumps the generation (invalidating the old ticket).
//     A confirmation arriving after the deadline is rejected as late.
//   - Cancel/timeout: the pending transfer is withdrawn and the original
//     holder keeps the resource.
//
// Invariant: at every instant, each registered resource has exactly one
// owner. Prepare never creates a second owner, Confirm atomically swaps
// the single owner under the registry lock, and Cancel/timeout leaves the
// owner untouched.
package ownership

import (
	"errors"
	"sync"
	"time"
)

var (
	ErrResourceExists     = errors.New("ownership: resource already registered")
	ErrResourceNotFound   = errors.New("ownership: resource not found")
	ErrStaleTicket        = errors.New("ownership: stale ticket (name reused with a new generation)")
	ErrNotOwner           = errors.New("ownership: caller is not the current owner")
	ErrTransferPending    = errors.New("ownership: a transfer is already pending for this resource")
	ErrTransferNotFound   = errors.New("ownership: transfer not found")
	ErrTransferNotPending = errors.New("ownership: transfer is no longer pending")
	ErrTransferExpired    = errors.New("ownership: transfer deadline passed, late confirmation rejected")
	ErrTransferNotExpired = errors.New("ownership: transfer deadline has not passed yet")
)

// Ticket identifies one generation of a named resource.
type Ticket struct {
	Name string
	Gen  uint64
}

type transferState int

const (
	transferPending transferState = iota
	transferConfirmed
	transferCancelled
	transferExpired
)

type transfer struct {
	id       uint64
	resource string
	gen      uint64 // generation the transfer was prepared against
	from     string
	to       string
	deadline time.Time
	state    transferState
}

type resource struct {
	owner   string
	gen     uint64
	pending uint64 // id of pending transfer, 0 = none
}

// Registry tracks resource ownership. The zero value is not usable;
// construct one with NewRegistry.
type Registry struct {
	mu        sync.Mutex
	now       func() time.Time
	resources map[string]*resource
	transfers map[uint64]*transfer
	nextGen   uint64
	nextTxID  uint64
}

// NewRegistry returns a registry using the real clock.
func NewRegistry() *Registry { return newRegistry(time.Now) }

// newRegistry allows tests to inject a deterministic clock.
func newRegistry(now func() time.Time) *Registry {
	return &Registry{
		now:       now,
		resources: make(map[string]*resource),
		transfers: make(map[uint64]*transfer),
		nextGen:   1,
		nextTxID:  1,
	}
}

// Register creates a resource owned by owner and returns its ticket.
func (r *Registry) Register(name, owner string) (Ticket, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.resources[name]; ok {
		return Ticket{}, ErrResourceExists
	}
	r.nextGen++
	r.resources[name] = &resource{owner: owner, gen: r.nextGen}
	return Ticket{Name: name, Gen: r.nextGen}, nil
}

// Release removes the resource identified by t. owner must be the current
// owner. A pending transfer, if any, is withdrawn. After release the name
// may be reused; the new incarnation gets a fresh generation, so tickets
// for the old incarnation become stale.
func (r *Registry) Release(t Ticket, owner string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	res, err := r.lookupLocked(t, owner)
	if err != nil {
		return err
	}
	if res.pending != 0 {
		r.transfers[res.pending].state = transferCancelled
	}
	delete(r.resources, t.Name)
	return nil
}

// OwnerOf returns the current owner and live ticket for name.
func (r *Registry) OwnerOf(name string) (owner string, t Ticket, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	res, exists := r.resources[name]
	if !exists {
		return "", Ticket{}, false
	}
	return res.owner, Ticket{Name: name, Gen: res.gen}, true
}

// Prepare opens a transfer of the resource identified by t from the
// current owner to recipient. The transfer must be confirmed before
// now+ttl. Ownership is unchanged by Prepare: the original holder still
// owns the resource until a successful Confirm.
func (r *Registry) Prepare(t Ticket, owner, recipient string, ttl time.Duration) (uint64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	res, err := r.lookupLocked(t, owner)
	if err != nil {
		return 0, err
	}
	if res.pending != 0 {
		return 0, ErrTransferPending
	}
	id := r.nextTxID
	r.nextTxID++
	r.transfers[id] = &transfer{
		id:       id,
		resource: t.Name,
		gen:      t.Gen,
		from:     owner,
		to:       recipient,
		deadline: r.now().Add(ttl),
		state:    transferPending,
	}
	res.pending = id
	return id, nil
}

// Confirm atomically moves ownership to the designated recipient and
// returns the recipient's new ticket. If the deadline has passed the
// transfer is marked expired and the late confirmation is rejected,
// leaving ownership with the original holder.
func (r *Registry) Confirm(id uint64) (Ticket, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	tx, ok := r.transfers[id]
	if !ok {
		return Ticket{}, ErrTransferNotFound
	}
	if tx.state != transferPending {
		return Ticket{}, ErrTransferNotPending
	}
	if !r.now().Before(tx.deadline) {
		tx.state = transferExpired
		if res, ok := r.resources[tx.resource]; ok && res.gen == tx.gen {
			res.pending = 0
		}
		return Ticket{}, ErrTransferExpired
	}
	res, ok := r.resources[tx.resource]
	if !ok || res.gen != tx.gen {
		tx.state = transferCancelled
		return Ticket{}, ErrTransferNotPending
	}
	// Atomic handoff: exactly one owner before and after this critical
	// section; the swap itself is a single assignment under the lock.
	r.nextGen++
	res.owner = tx.to
	res.gen = r.nextGen
	res.pending = 0
	tx.state = transferConfirmed
	return Ticket{Name: tx.resource, Gen: res.gen}, nil
}

// Cancel withdraws a pending transfer. The original holder keeps the
// resource. Cancel after the deadline is treated as a timeout withdrawal.
func (r *Registry) Cancel(id uint64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	tx, ok := r.transfers[id]
	if !ok {
		return ErrTransferNotFound
	}
	if tx.state != transferPending {
		return ErrTransferNotPending
	}
	if !r.now().Before(tx.deadline) {
		tx.state = transferExpired
	} else {
		tx.state = transferCancelled
	}
	if res, ok := r.resources[tx.resource]; ok && res.gen == tx.gen {
		res.pending = 0
	}
	return nil
}

// ExpireTimeouts sweeps all pending transfers whose deadline has passed
// and marks them expired (timeout withdrawal). Ownership is untouched.
// Returns the number of transfers expired by this call.
func (r *Registry) ExpireTimeouts() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	expired := 0
	for _, tx := range r.transfers {
		if tx.state != transferPending || now.Before(tx.deadline) {
			continue
		}
		tx.state = transferExpired
		if res, ok := r.resources[tx.resource]; ok && res.gen == tx.gen {
			res.pending = 0
		}
		expired++
	}
	return expired
}

// Owners returns a consistent snapshot of name -> owner for every
// registered resource. Each name appears exactly once, so the snapshot
// always shows exactly one owner per resource.
func (r *Registry) Owners() map[string]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	snap := make(map[string]string, len(r.resources))
	for name, res := range r.resources {
		snap[name] = res.owner
	}
	return snap
}

// PendingTransfer reports whether name currently has a pending transfer
// and, if so, the designated recipient.
func (r *Registry) PendingTransfer(name string) (recipient string, pending bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	res, ok := r.resources[name]
	if !ok || res.pending == 0 {
		return "", false
	}
	return r.transfers[res.pending].to, true
}

func (r *Registry) lookupLocked(t Ticket, owner string) (*resource, error) {
	res, ok := r.resources[t.Name]
	if !ok {
		return nil, ErrResourceNotFound
	}
	if res.gen != t.Gen {
		return nil, ErrStaleTicket
	}
	if res.owner != owner {
		return nil, ErrNotOwner
	}
	return res, nil
}
