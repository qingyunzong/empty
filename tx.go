package pagestore

import "errors"

// ErrTxDone is returned when committing an already finished transaction.
var ErrTxDone = errors.New("pagestore: transaction already finished")

// Tx is a write transaction. Writes are buffered as an in-memory draft
// and consume no quota until Commit. A failed Commit leaves the draft
// intact: the caller may keep editing and retry.
type Tx struct {
	store   *Store
	writes  map[string][]byte
	deletes map[string]struct{}
	done    bool
}

// Begin opens a write transaction on s.
func (s *Store) Begin() *Tx {
	return &Tx{
		store:   s,
		writes:  map[string][]byte{},
		deletes: map[string]struct{}{},
	}
}

// Put stages a write of val under key. The value is copied.
func (tx *Tx) Put(key string, val []byte) {
	tx.writes[key] = append([]byte(nil), val...)
	delete(tx.deletes, key)
}

// Delete stages a removal of key.
func (tx *Tx) Delete(key string) {
	delete(tx.writes, key)
	tx.deletes[key] = struct{}{}
}

// Commit attempts to atomically publish the draft as the new root
// version. On ErrQuotaExceeded or a backend error nothing is published,
// no quota is consumed, and the draft is preserved for retry.
func (tx *Tx) Commit() error {
	if tx.done {
		return ErrTxDone
	}
	if err := tx.store.commit(tx); err != nil {
		return err
	}
	tx.done = true
	return nil
}

// Abort discards the draft.
func (tx *Tx) Abort() {
	tx.done = true
}
