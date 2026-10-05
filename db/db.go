// Package db is a page store with ARIES-style write-ahead logging.
//
// Policies: STEAL (dirty pages of uncommitted transactions may be
// flushed to disk) and NO-FORCE (commit does not flush data pages, only
// the log). The WAL rule is enforced: before a dirty page is written
// out, the log is flushed up to the page's pageLSN.
package db

import (
	"encoding/binary"
	"fmt"
	"path/filepath"
	"sync"

	"pagestore/fileadapter"
	"pagestore/wal"
)

// PageHeaderLen bytes at the start of every page hold the pageLSN.
const PageHeaderLen = 8

// MaxWrite is the largest single Write payload.
const MaxWrite = fileadapter.PageSize - PageHeaderLen

type frame struct {
	data    [fileadapter.PageSize]byte
	pageLSN int64
	dirty   bool
}

// DB couples a buffer pool over a FileAdapter with a WAL.
type DB struct {
	mu      sync.Mutex
	adapter *fileadapter.FileAdapter
	log     *wal.Log
	pages   map[uint64]*frame
	txnLast map[uint64]int64
	nextTxn uint64
}

// Open opens the data and log files in dir. It does not run recovery;
// call Recover after a crash before starting new work.
func Open(dir string) (*DB, error) {
	adapter, err := fileadapter.Open(filepath.Join(dir, "data.db"))
	if err != nil {
		return nil, err
	}
	lg, err := wal.Open(filepath.Join(dir, "wal.log"))
	if err != nil {
		adapter.Close()
		return nil, err
	}
	db := &DB{
		adapter: adapter,
		log:     lg,
		pages:   make(map[uint64]*frame),
		txnLast: make(map[uint64]int64),
		nextTxn: 1,
	}
	// Transaction IDs must not collide with IDs already in the log.
	recs, err := lg.Scan()
	if err != nil {
		db.Close()
		return nil, err
	}
	for _, r := range recs {
		if r.TxnID >= db.nextTxn {
			db.nextTxn = r.TxnID + 1
		}
	}
	return db, nil
}

// Begin starts a transaction and returns its ID.
func (db *DB) Begin() uint64 {
	db.mu.Lock()
	defer db.mu.Unlock()
	id := db.nextTxn
	db.nextTxn++
	db.txnLast[id] = wal.NullLSN
	return id
}

func (db *DB) getPageLocked(pageID uint64) (*frame, error) {
	if fr, ok := db.pages[pageID]; ok {
		return fr, nil
	}
	fr := &frame{}
	if err := db.adapter.ReadPage(pageID, fr.data[:]); err != nil {
		return nil, err
	}
	fr.pageLSN = int64(binary.LittleEndian.Uint64(fr.data[0:PageHeaderLen]))
	db.pages[pageID] = fr
	return fr, nil
}

// Write replaces the bytes at [off, off+len(data)) of page pageID with
// data, logging the before and after images first (WAL).
func (db *DB) Write(txnID, pageID uint64, off int, data []byte) error {
	if len(data) == 0 || off < 0 || off+len(data) > MaxWrite {
		return fmt.Errorf("db: write out of range: off=%d len=%d", off, len(data))
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	if _, ok := db.txnLast[txnID]; !ok {
		return fmt.Errorf("db: txn %d not active", txnID)
	}
	fr, err := db.getPageLocked(pageID)
	if err != nil {
		return err
	}
	base := PageHeaderLen + off
	before := append([]byte(nil), fr.data[base:base+len(data)]...)
	rec := &wal.Record{
		Type:    wal.RecUpdate,
		TxnID:   txnID,
		PrevLSN: db.txnLast[txnID],
		PageID:  pageID,
		Offset:  uint32(off),
		Before:  before,
		After:   append([]byte(nil), data...),
	}
	lsn := db.log.Append(rec)
	copy(fr.data[base:], data)
	binary.LittleEndian.PutUint64(fr.data[0:PageHeaderLen], uint64(lsn))
	fr.pageLSN = lsn
	fr.dirty = true
	db.txnLast[txnID] = lsn
	return nil
}

// Commit makes txnID durable: the commit record is appended and the log
// is flushed (NO-FORCE: data pages are not flushed).
func (db *DB) Commit(txnID uint64) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	prev, ok := db.txnLast[txnID]
	if !ok {
		return fmt.Errorf("db: txn %d not active", txnID)
	}
	commitLSN := db.log.Append(&wal.Record{Type: wal.RecCommit, TxnID: txnID, PrevLSN: prev})
	if err := db.log.Flush(); err != nil {
		return err
	}
	db.log.Append(&wal.Record{Type: wal.RecEnd, TxnID: txnID, PrevLSN: commitLSN})
	delete(db.txnLast, txnID)
	return nil
}

// Abort rolls txnID back at runtime, writing compensation records.
func (db *DB) Abort(txnID uint64) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	prev, ok := db.txnLast[txnID]
	if !ok {
		return fmt.Errorf("db: txn %d not active", txnID)
	}
	db.txnLast[txnID] = db.log.Append(&wal.Record{Type: wal.RecAbort, TxnID: txnID, PrevLSN: prev})
	cur := prev
	for cur != wal.NullLSN {
		rec := db.log.Lookup(cur)
		if rec == nil {
			return fmt.Errorf("db: broken chain at lsn %d", cur)
		}
		switch rec.Type {
		case wal.RecUpdate:
			if err := db.writeCLRLocked(txnID, rec); err != nil {
				return err
			}
			cur = rec.PrevLSN
		case wal.RecCLR:
			cur = rec.UndoNextLSN
		default:
			cur = rec.PrevLSN
		}
	}
	db.log.Append(&wal.Record{Type: wal.RecEnd, TxnID: txnID, PrevLSN: db.txnLast[txnID]})
	delete(db.txnLast, txnID)
	return db.log.Flush()
}

// writeCLRLocked appends a CLR for rec and applies its before-image to
// the cached page. The caller must hold db.mu.
func (db *DB) writeCLRLocked(txnID uint64, rec *wal.Record) (err error) {
	fr, err := db.getPageLocked(rec.PageID)
	if err != nil {
		return err
	}
	clr := &wal.Record{
		Type:        wal.RecCLR,
		TxnID:       txnID,
		PrevLSN:     db.txnLast[txnID],
		PageID:      rec.PageID,
		Offset:      rec.Offset,
		After:       append([]byte(nil), rec.Before...),
		UndoNextLSN: rec.PrevLSN,
	}
	lsn := db.log.Append(clr)
	base := PageHeaderLen + int(rec.Offset)
	copy(fr.data[base:base+len(clr.After)], clr.After)
	binary.LittleEndian.PutUint64(fr.data[0:PageHeaderLen], uint64(lsn))
	fr.pageLSN = lsn
	fr.dirty = true
	db.txnLast[txnID] = lsn
	return nil
}

// FlushPage writes the cached copy of pageID to disk if dirty, honoring
// the WAL rule: the log is flushed before the page.
func (db *DB) FlushPage(pageID uint64) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	fr, ok := db.pages[pageID]
	if !ok || !fr.dirty {
		return nil
	}
	if err := db.log.Flush(); err != nil {
		return err
	}
	if err := db.adapter.WritePage(pageID, fr.data[:]); err != nil {
		return err
	}
	if err := db.adapter.Sync(); err != nil {
		return err
	}
	fr.dirty = false
	return nil
}

// FlushLog forces all staged log records to stable storage.
func (db *DB) FlushLog() error {
	db.mu.Lock()
	defer db.mu.Unlock()
	return db.log.Flush()
}

// ReadPage reads pageID from disk (bypassing the buffer pool).
func (db *DB) ReadPage(pageID uint64) ([]byte, error) {
	buf := make([]byte, fileadapter.PageSize)
	if err := db.adapter.ReadPage(pageID, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

// Close simulates a crash when called with unflushed state: nothing is
// flushed, staged log records and dirty pages are simply lost.
func (db *DB) Close() error {
	err := db.log.Close()
	if e := db.adapter.Close(); err == nil {
		err = e
	}
	return err
}
