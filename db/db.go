// Package db ties the WAL and the page store into a transaction manager
// and implements ARIES-style recovery: redo repeats history, undo rolls
// back losers with compensation log records, so recovery stays
// idempotent even when a crash interrupts undo itself.
package db

import (
	"errors"

	"pagedb/pagestore"
	"pagedb/wal"
)

var (
	// ErrTxDone is returned when a finished transaction is used again.
	ErrTxDone = errors.New("db: transaction already finished")
	// ErrCorrupt is returned when an undo chain references a record
	// that is not present in the log.
	ErrCorrupt = errors.New("db: undo chain references missing record")
)

// Manager hands out transactions and owns the in-session record index
// (including records not yet synced to disk).
type Manager struct {
	Log    *wal.Log
	Store  *pagestore.Store
	nextTx uint64
	recs   map[uint64]*wal.Record
	hook   func(lsn uint64)
}

// NewManager creates a Manager on top of an open log and store.
func NewManager(l *wal.Log, s *pagestore.Store) *Manager {
	return &Manager{Log: l, Store: s, recs: make(map[uint64]*wal.Record)}
}

// SetAppendHook registers h to be called after every log append with
// the new record's LSN. Tests use it to flush pages at exact record
// boundaries; production code leaves it nil.
func (m *Manager) SetAppendHook(h func(lsn uint64)) { m.hook = h }

func (m *Manager) append(rec *wal.Record) uint64 {
	lsn := m.Log.Append(rec)
	m.recs[lsn] = rec
	if m.hook != nil {
		m.hook(lsn)
	}
	return lsn
}

// writeCLR compensates one update record: it logs a CLR (chained on the
// transaction's lastLSN, pointing at the next record to undo) and
// restores the before-image in the buffer pool.
func (m *Manager) writeCLR(rec *wal.Record, lastLSN uint64) (uint64, error) {
	p, err := m.Store.Fetch(rec.PageID)
	if err != nil {
		return 0, err
	}
	clr := &wal.Record{
		PrevLSN:  lastLSN,
		TxID:     rec.TxID,
		Type:     wal.RecCLR,
		PageID:   rec.PageID,
		UndoNext: rec.PrevLSN,
		After:    append([]byte(nil), rec.Before...),
	}
	lsn := m.append(clr)
	copy(p.Data, rec.Before)
	p.LSN = lsn
	p.Dirty = true
	return lsn, nil
}

// nextUndo follows the undo chain: a CLR skips already-compensated
// records via UndoNext, anything else steps to its predecessor.
func nextUndo(rec *wal.Record) uint64 {
	if rec.Type == wal.RecCLR {
		return rec.UndoNext
	}
	return rec.PrevLSN
}

// Tx is a single transaction. Transactions are single-threaded; page
// locks are held to commit, so writers of one page never overlap.
type Tx struct {
	m       *Manager
	ID      uint64
	LastLSN uint64
	done    bool
}

// Begin starts a new transaction.
func (m *Manager) Begin() *Tx {
	m.nextTx++
	return &Tx{m: m, ID: m.nextTx}
}

// Write replaces the contents of pageID, logging before/after images.
func (t *Tx) Write(pageID uint32, data []byte) error {
	if t.done {
		return ErrTxDone
	}
	p, err := t.m.Store.Fetch(pageID)
	if err != nil {
		return err
	}
	rec := &wal.Record{
		PrevLSN: t.LastLSN,
		TxID:    t.ID,
		Type:    wal.RecUpdate,
		PageID:  pageID,
		Before:  append([]byte(nil), p.Data...),
		After:   append([]byte(nil), data...),
	}
	lsn := t.m.append(rec)
	t.LastLSN = lsn
	copy(p.Data, data)
	p.LSN = lsn
	p.Dirty = true
	return nil
}

// Commit forces the log up to the commit record (no-force: pages are
// not flushed) and logs the transaction end.
func (t *Tx) Commit() error {
	if t.done {
		return ErrTxDone
	}
	t.done = true
	t.LastLSN = t.m.append(&wal.Record{PrevLSN: t.LastLSN, TxID: t.ID, Type: wal.RecCommit})
	if err := t.m.Log.Sync(); err != nil {
		return err
	}
	t.LastLSN = t.m.append(&wal.Record{PrevLSN: t.LastLSN, TxID: t.ID, Type: wal.RecEnd})
	return nil
}

// Abort rolls the transaction back with CLRs (so an interrupted abort is
// itself recoverable), then logs abort and end records.
func (t *Tx) Abort() error {
	if t.done {
		return ErrTxDone
	}
	t.done = true
	last := t.LastLSN
	for lsn := t.LastLSN; lsn != 0; {
		rec := t.m.recs[lsn]
		if rec == nil {
			return ErrCorrupt
		}
		if rec.Type == wal.RecUpdate {
			clrLSN, err := t.m.writeCLR(rec, last)
			if err != nil {
				return err
			}
			last = clrLSN
		}
		lsn = nextUndo(rec)
	}
	t.LastLSN = t.m.append(&wal.Record{PrevLSN: last, TxID: t.ID, Type: wal.RecAbort})
	t.LastLSN = t.m.append(&wal.Record{PrevLSN: t.LastLSN, TxID: t.ID, Type: wal.RecEnd})
	return t.m.Log.Sync()
}
