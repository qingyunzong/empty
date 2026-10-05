// Package txcache implements a transactional key-value cache whose
// handles are bound to a transaction generation. Once a transaction
// commits or rolls back, every handle minted by it is permanently
// rejected. Nested savepoint rollbacks invalidate only the handles
// created after the savepoint; older handles observe restored values.
package txcache

import (
	"errors"
	"sync"
)

var (
	// ErrTxClosed is returned by any handle operation whose transaction
	// has already committed or rolled back.
	ErrTxClosed = errors.New("txcache: transaction is closed")

	// ErrHandleInvalid is returned when a handle was invalidated by a
	// savepoint rollback, or when a handle does not belong to the
	// transaction generation it is used with.
	ErrHandleInvalid = errors.New("txcache: handle is invalid")
)

// Cache is the committed store. Transactions read through their own
// overlay and fall back to the committed state.
type Cache struct {
	mu     sync.Mutex
	data   map[string]string
	nextTx uint64 // global transaction generation counter
}

// New returns an empty cache.
func New() *Cache {
	return &Cache{data: make(map[string]string)}
}

// Get reads committed state directly, outside any transaction.
func (c *Cache) Get(key string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.data[key]
	return v, ok
}

// Begin opens a new transaction with a fresh generation ID.
func (c *Cache) Begin() *Tx {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nextTx++
	return &Tx{
		cache:   c,
		id:      c.nextTx,
		overlay: make(map[string]overlayEntry),
		live:    make(map[uint64]bool),
	}
}

type overlayEntry struct {
	value string
	del   bool
}

// undoEntry restores the prior overlay state of one key.
type undoEntry struct {
	key  string
	prev overlayEntry
	had  bool
}

// savepoint marks a position in the undo log and the handle counter.
type savepoint struct {
	logLen     int
	handleMark uint64
}

// Tx is a single-generation transaction. It is not safe for concurrent
// use; Cache-level commit is serialized internally.
type Tx struct {
	cache *Cache
	id    uint64 // transaction generation

	overlay map[string]overlayEntry
	log     []undoEntry
	sp      []savepoint

	live       map[uint64]bool // currently valid handle IDs
	nextHandle uint64          // per-tx handle IDs restart at 0 each generation

	closed bool
}

// ID returns the transaction generation.
func (tx *Tx) ID() uint64 { return tx.id }

// Handle is a key accessor bound to one transaction generation.
type Handle struct {
	tx   *Tx
	txID uint64
	id   uint64
	key  string
}

// Handle mints a new handle for key within this transaction.
// Handles on a closed transaction are still returned but every
// operation on them fails; minting itself never errors.
func (tx *Tx) Handle(key string) *Handle {
	h := &Handle{tx: tx, txID: tx.id, id: tx.nextHandle, key: key}
	if !tx.closed {
		tx.live[h.id] = true
		tx.nextHandle++
	}
	return h
}

// check validates the handle against its transaction generation.
func (h *Handle) check() error {
	tx := h.tx
	if tx.closed || h.txID != tx.id {
		return ErrTxClosed
	}
	if !tx.live[h.id] {
		return ErrHandleInvalid
	}
	return nil
}

// Get reads the key through the transaction overlay.
func (h *Handle) Get() (string, bool, error) {
	if err := h.check(); err != nil {
		return "", false, err
	}
	if e, ok := h.tx.overlay[h.key]; ok {
		if e.del {
			return "", false, nil
		}
		return e.value, true, nil
	}
	v, ok := h.tx.cache.Get(h.key)
	return v, ok, nil
}

// Set stages a write in the transaction overlay.
func (h *Handle) Set(value string) error {
	if err := h.check(); err != nil {
		return err
	}
	tx := h.tx
	prev, had := tx.overlay[h.key]
	tx.log = append(tx.log, undoEntry{key: h.key, prev: prev, had: had})
	tx.overlay[h.key] = overlayEntry{value: value}
	return nil
}

// Delete stages a delete in the transaction overlay.
func (h *Handle) Delete() error {
	if err := h.check(); err != nil {
		return err
	}
	tx := h.tx
	prev, had := tx.overlay[h.key]
	tx.log = append(tx.log, undoEntry{key: h.key, prev: prev, had: had})
	tx.overlay[h.key] = overlayEntry{del: true}
	return nil
}

// Savepoint records a nested savepoint and returns its index.
func (tx *Tx) Savepoint() (int, error) {
	if tx.closed {
		return 0, ErrTxClosed
	}
	tx.sp = append(tx.sp, savepoint{logLen: len(tx.log), handleMark: tx.nextHandle})
	return len(tx.sp) - 1, nil
}

// RollbackTo undoes all writes made after the savepoint and invalidates
// every handle minted after it. Handles minted before the savepoint stay
// valid and observe the restored values. Later savepoints are discarded.
func (tx *Tx) RollbackTo(sp int) error {
	if tx.closed {
		return ErrTxClosed
	}
	if sp < 0 || sp >= len(tx.sp) {
		return errors.New("txcache: unknown savepoint")
	}
	mark := tx.sp[sp]
	for i := len(tx.log) - 1; i >= mark.logLen; i-- {
		u := tx.log[i]
		if u.had {
			tx.overlay[u.key] = u.prev
		} else {
			delete(tx.overlay, u.key)
		}
	}
	tx.log = tx.log[:mark.logLen]
	for id := mark.handleMark; id < tx.nextHandle; id++ {
		delete(tx.live, id)
	}
	tx.sp = tx.sp[:sp]
	return nil
}

// Commit applies the overlay to the committed store and closes the
// transaction. All of its handles are rejected from then on.
func (tx *Tx) Commit() error {
	if tx.closed {
		return ErrTxClosed
	}
	tx.cache.mu.Lock()
	for k, e := range tx.overlay {
		if e.del {
			delete(tx.cache.data, k)
		} else {
			tx.cache.data[k] = e.value
		}
	}
	tx.cache.mu.Unlock()
	tx.close()
	return nil
}

// Rollback discards the overlay and closes the transaction.
// All of its handles are rejected from then on.
func (tx *Tx) Rollback() error {
	if tx.closed {
		return ErrTxClosed
	}
	tx.close()
	return nil
}

func (tx *Tx) close() {
	tx.closed = true
	tx.live = nil
	tx.overlay = nil
	tx.log = nil
	tx.sp = nil
}
