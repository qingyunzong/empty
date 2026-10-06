// Package txcache implements a transactional in-memory cache with
// generation-bound handles and nested savepoints.
//
// Semantics:
//   - Every transaction carries a unique generation. Handles created inside
//     a transaction are bound to that generation: once the transaction
//     commits or rolls back, all of its handles reject further operations
//     with ErrInvalidHandle.
//   - Savepoints nest. Rolling back to a savepoint restores the pending
//     writes to the snapshot taken at that savepoint, invalidates only the
//     handles created after it, and keeps older handles usable with their
//     original (restored) values.
//   - Handle IDs are per-transaction counters that are rewound on savepoint
//     rollback, so IDs may be reused by newer handles. A never-reused nonce
//     ensures a reused ID can never resurrect a stale handle.
package txcache

import (
	"errors"
	"fmt"
	"sync"
)

// ErrInvalidHandle is returned by handle operations whose handle is no
// longer valid: its transaction finished, or a savepoint rollback
// invalidated it (including when its ID was later reused by a new handle).
var ErrInvalidHandle = errors.New("txcache: handle is no longer valid")

// ErrTxnClosed is returned by transaction operations on a transaction that
// has already committed or rolled back.
var ErrTxnClosed = errors.New("txcache: transaction is already closed")

// ErrBadSavepoint is returned when rolling back to an unknown savepoint.
var ErrBadSavepoint = errors.New("txcache: unknown savepoint")

type txnState int

const (
	stateActive txnState = iota
	stateCommitted
	stateRolledBack
)

// Cache is the committed store. Transactions read through to it and apply
// their pending writes on commit.
type Cache struct {
	mu   sync.RWMutex
	data map[string]string
	gen  uint64
}

// New returns an empty cache.
func New() *Cache {
	return &Cache{data: make(map[string]string)}
}

// Get reads a committed value.
func (c *Cache) Get(key string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	v, ok := c.data[key]
	return v, ok
}

// Begin starts a new transaction with a fresh, unique generation.
func (c *Cache) Begin() *Txn {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gen++
	return &Txn{
		cache:   c,
		gen:     c.gen,
		overlay: make(map[string]*string),
		live:    make(map[uint64]uint64),
	}
}

// Generation returns the transaction's unique generation number.
func (t *Txn) Generation() uint64 { return t.gen }

// Txn is a single transaction. It is safe for concurrent use.
type Txn struct {
	cache *Cache
	gen   uint64

	mu      sync.Mutex
	state   txnState
	overlay map[string]*string // nil value means "deleted"
	sps     []savepoint
	live    map[uint64]uint64 // handle ID -> nonce of the live handle
	nextID  uint64            // next handle ID; rewound by savepoint rollback
	nonce   uint64            // never reused; distinguishes handles sharing an ID
}

type savepoint struct {
	overlay map[string]*string
	nextID  uint64
}

func cloneOverlay(src map[string]*string) map[string]*string {
	dst := make(map[string]*string, len(src))
	for k, v := range src {
		if v == nil {
			dst[k] = nil
		} else {
			s := *v
			dst[k] = &s
		}
	}
	return dst
}

// Handle returns a new handle bound to key within this transaction.
func (t *Txn) Handle(key string) (*Handle, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.state != stateActive {
		return nil, ErrTxnClosed
	}
	id := t.nextID
	t.nextID++
	t.nonce++
	t.live[id] = t.nonce
	return &Handle{txn: t, id: id, nonce: t.nonce, key: key}, nil
}

// Savepoint records the current pending writes and handle counter, and
// returns a token usable with RollbackTo. Tokens remain valid after being
// rolled back to (SQL ROLLBACK TO SAVEPOINT semantics).
func (t *Txn) Savepoint() (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.state != stateActive {
		return -1, ErrTxnClosed
	}
	t.sps = append(t.sps, savepoint{overlay: cloneOverlay(t.overlay), nextID: t.nextID})
	return len(t.sps) - 1, nil
}

// RollbackTo restores the pending writes to the given savepoint and
// invalidates every handle created after it. Handles created before the
// savepoint stay valid and observe their restored values.
func (t *Txn) RollbackTo(sp int) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.state != stateActive {
		return ErrTxnClosed
	}
	if sp < 0 || sp >= len(t.sps) {
		return fmt.Errorf("%w: %d", ErrBadSavepoint, sp)
	}
	snap := t.sps[sp]
	t.overlay = cloneOverlay(snap.overlay)
	for id := range t.live {
		if id >= snap.nextID {
			delete(t.live, id)
		}
	}
	t.nextID = snap.nextID
	t.sps = t.sps[:sp+1]
	return nil
}

// Commit applies the pending writes to the cache and closes the
// transaction, invalidating all of its handles.
func (t *Txn) Commit() error {
	t.mu.Lock()
	if t.state != stateActive {
		t.mu.Unlock()
		return ErrTxnClosed
	}
	t.state = stateCommitted
	t.live = make(map[uint64]uint64)
	overlay := t.overlay
	t.mu.Unlock()

	t.cache.mu.Lock()
	for k, v := range overlay {
		if v == nil {
			delete(t.cache.data, k)
		} else {
			t.cache.data[k] = *v
		}
	}
	t.cache.mu.Unlock()
	return nil
}

// Rollback discards the pending writes and closes the transaction,
// invalidating all of its handles.
func (t *Txn) Rollback() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.state != stateActive {
		return ErrTxnClosed
	}
	t.state = stateRolledBack
	t.live = make(map[uint64]uint64)
	t.overlay = make(map[string]*string)
	return nil
}

// Handle is a cursor on a single key inside a transaction. It is valid only
// while its transaction is active and no savepoint rollback has invalidated
// it. A Handle carries a nonce so that a reused ID cannot resurrect it.
type Handle struct {
	txn   *Txn
	id    uint64
	nonce uint64
	key   string
}

// Key returns the key the handle is bound to.
func (h *Handle) Key() string { return h.key }

// check reports whether the handle is currently usable.
func (h *Handle) check(t *Txn) error {
	if t.state != stateActive {
		return ErrInvalidHandle
	}
	if nonce, ok := t.live[h.id]; !ok || nonce != h.nonce {
		return ErrInvalidHandle
	}
	return nil
}

// Get reads the value visible through this handle: pending writes of the
// transaction first, then committed data.
func (h *Handle) Get() (string, bool, error) {
	t := h.txn
	t.mu.Lock()
	defer t.mu.Unlock()
	if err := h.check(t); err != nil {
		return "", false, err
	}
	if v, ok := t.overlay[h.key]; ok {
		if v == nil {
			return "", false, nil
		}
		return *v, true, nil
	}
	t.cache.mu.RLock()
	v, ok := t.cache.data[h.key]
	t.cache.mu.RUnlock()
	return v, ok, nil
}

// Set stages a write to the handle's key.
func (h *Handle) Set(value string) error {
	t := h.txn
	t.mu.Lock()
	defer t.mu.Unlock()
	if err := h.check(t); err != nil {
		return err
	}
	v := value
	t.overlay[h.key] = &v
	return nil
}

// Delete stages a deletion of the handle's key.
func (h *Handle) Delete() error {
	t := h.txn
	t.mu.Lock()
	defer t.mu.Unlock()
	if err := h.check(t); err != nil {
		return err
	}
	t.overlay[h.key] = nil
	return nil
}
