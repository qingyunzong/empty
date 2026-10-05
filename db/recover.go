package db

import (
	"encoding/binary"
	"errors"
	"fmt"
	"sort"

	"pagestore/fileadapter"
	"pagestore/wal"
)

// ErrSimulatedCrash is returned by Recover when the CrashAfterCLRs test
// hook fires, modeling a crash that interrupts undo midway.
var ErrSimulatedCrash = errors.New("db: simulated crash during undo")

// Report summarizes one recovery pass.
type Report struct {
	RecordsScanned int
	Winners        []uint64 // committed transactions
	Losers         []uint64 // transactions rolled back by undo
	Redone         int      // update/CLR records applied during redo
	CLRsWritten    int      // compensation records written during undo
}

// RecoverOptions tunes recovery. CrashAfterCLRs > 0 makes Recover flush
// everything and return ErrSimulatedCrash after writing that many CLRs,
// simulating a crash in the middle of undo.
type RecoverOptions struct {
	CrashAfterCLRs int
}

// Recover performs ARIES-style recovery: analysis of the log, redo of
// all logged updates (repeating history), then undo of loser
// transactions via compensation records. It is idempotent: redone work
// is skipped via pageLSN checks, and interrupted undo resumes through
// CLR undo-next pointers, so Recover may be re-run after a crash at any
// point, including during undo itself.
func (db *DB) Recover(opts RecoverOptions) (*Report, error) {
	db.mu.Lock()
	defer db.mu.Unlock()

	// Recovery works on the disk image; drop any stale cached pages.
	db.pages = make(map[uint64]*frame)

	recs, err := db.log.Scan()
	if err != nil {
		return nil, err
	}
	rep := &Report{RecordsScanned: len(recs)}

	byLSN := make(map[int64]*wal.Record, len(recs))
	lastLSN := make(map[uint64]int64)
	committed := make(map[uint64]bool)
	ended := make(map[uint64]bool)
	for _, r := range recs {
		byLSN[r.LSN] = r
		lastLSN[r.TxnID] = r.LSN
		switch r.Type {
		case wal.RecCommit:
			committed[r.TxnID] = true
		case wal.RecEnd:
			ended[r.TxnID] = true
		}
	}
	var losers []uint64
	for txn := range lastLSN {
		if committed[txn] {
			rep.Winners = append(rep.Winners, txn)
		} else if !ended[txn] {
			losers = append(losers, txn)
		}
	}
	sort.Slice(rep.Winners, func(i, j int) bool { return rep.Winners[i] < rep.Winners[j] })
	sort.Slice(losers, func(i, j int) bool { return losers[i] < losers[j] })
	rep.Losers = losers

	// Redo: repeat history. A record is applied only if the page on disk
	// is older than the record (pageLSN check keeps redo idempotent).
	dirty := make(map[uint64]*[fileadapter.PageSize]byte)
	load := func(pageID uint64) (*[fileadapter.PageSize]byte, error) {
		if pg, ok := dirty[pageID]; ok {
			return pg, nil
		}
		pg := new([fileadapter.PageSize]byte)
		if err := db.adapter.ReadPage(pageID, pg[:]); err != nil {
			return nil, err
		}
		dirty[pageID] = pg
		return pg, nil
	}
	apply := func(pageID uint64, off uint32, img []byte, lsn int64) error {
		pg, err := load(pageID)
		if err != nil {
			return err
		}
		base := PageHeaderLen + int(off)
		copy(pg[base:base+len(img)], img)
		binary.LittleEndian.PutUint64(pg[0:PageHeaderLen], uint64(lsn))
		return nil
	}
	for _, r := range recs {
		if r.Type != wal.RecUpdate && r.Type != wal.RecCLR {
			continue
		}
		pg, err := load(r.PageID)
		if err != nil {
			return rep, err
		}
		pageLSN := int64(binary.LittleEndian.Uint64(pg[0:PageHeaderLen]))
		if pageLSN < r.LSN {
			if err := apply(r.PageID, r.Offset, r.After, r.LSN); err != nil {
				return rep, err
			}
			rep.Redone++
		}
	}

	// Undo: roll back losers, largest LSN first, writing a CLR per
	// undone update. CLRs make undo itself idempotent: after a crash
	// during undo, redo re-applies the CLR images and undo resumes from
	// each CLR's undo-next pointer instead of undoing twice.
	pending := make(map[uint64]int64, len(losers)) // txn -> next LSN to examine
	for _, txn := range losers {
		pending[txn] = lastLSN[txn]
		db.txnLast[txn] = lastLSN[txn]
	}
	for len(pending) > 0 {
		// Pick the maximum pending LSN across losers.
		pickLSN := wal.NullLSN
		for _, lsn := range pending {
			if lsn > pickLSN {
				pickLSN = lsn
			}
		}
		rec := byLSN[pickLSN]
		if rec == nil {
			return rep, fmt.Errorf("db: undo: missing record at lsn %d", pickLSN)
		}
		var next int64
		switch rec.Type {
		case wal.RecUpdate:
			clr := &wal.Record{
				Type:        wal.RecCLR,
				TxnID:       rec.TxnID,
				PrevLSN:     db.txnLast[rec.TxnID],
				PageID:      rec.PageID,
				Offset:      rec.Offset,
				After:       append([]byte(nil), rec.Before...),
				UndoNextLSN: rec.PrevLSN,
			}
			lsn := db.log.Append(clr)
			db.txnLast[rec.TxnID] = lsn
			byLSN[lsn] = clr
			if err := apply(rec.PageID, rec.Offset, clr.After, lsn); err != nil {
				return rep, err
			}
			rep.CLRsWritten++
			next = rec.PrevLSN
			if opts.CrashAfterCLRs > 0 && rep.CLRsWritten >= opts.CrashAfterCLRs {
				if err := db.flushRecoveredLocked(dirty); err != nil {
					return rep, err
				}
				return rep, ErrSimulatedCrash
			}
		case wal.RecCLR:
			next = rec.UndoNextLSN // already undone; skip
		default:
			next = rec.PrevLSN
		}
		if next == wal.NullLSN {
			endRec := &wal.Record{Type: wal.RecEnd, TxnID: rec.TxnID, PrevLSN: db.txnLast[rec.TxnID]}
			byLSN[db.log.Append(endRec)] = endRec
			delete(pending, rec.TxnID)
			delete(db.txnLast, rec.TxnID)
		} else {
			pending[rec.TxnID] = next
		}
	}

	if err := db.flushRecoveredLocked(dirty); err != nil {
		return rep, err
	}
	return rep, nil
}

// flushRecoveredLocked persists recovered pages and the log.
func (db *DB) flushRecoveredLocked(dirty map[uint64]*[fileadapter.PageSize]byte) error {
	for pageID, pg := range dirty {
		if err := db.adapter.WritePage(pageID, pg[:]); err != nil {
			return err
		}
	}
	if err := db.adapter.Sync(); err != nil {
		return err
	}
	return db.log.Flush()
}
