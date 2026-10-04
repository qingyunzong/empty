package db

import (
	"fmt"
	"path/filepath"
	"sort"

	"pagedb/pagestore"
	"pagedb/wal"
)

// transaction states discovered by the analysis pass.
const (
	stRunning = iota
	stCommitted
	stAborted
	stEnded
)

type txState struct {
	lastLSN uint64
	status  int
}

// Report summarizes one recovery run.
type Report struct {
	Winners []uint64 // committed transactions (kept)
	Losers  []uint64 // uncommitted transactions (undone)
	Redone  int      // update/CLR records replayed onto pages
	CLRs    int      // compensation records written during undo
	Crashed bool     // a simulated crash (Options.CrashAfterCLR) fired
}

// Options tunes a recovery run; the zero value is a plain recovery.
type Options struct {
	// CrashAfterCLR, when > 0, simulates a crash after the Nth CLR is
	// written during undo: recovery stops immediately, keeping only
	// what was synced/flushed. Used to prove undo is idempotent.
	CrashAfterCLR int
	// FlushOnCLR steals the compensated page to disk after every CLR.
	FlushOnCLR bool
}

// Recover runs ARIES-style recovery on the database directory dir
// (containing wal.log and pages.dat):
//
//  1. analysis: rebuild the transaction table from the durable log;
//  2. redo: repeat history — replay every update/CLR whose LSN is newer
//     than the page LSN on disk (this is what makes redo idempotent);
//  3. undo: roll back every loser with CLRs, highest LSN first; each CLR
//     is synced before undo proceeds, and its UndoNext pointer lets a
//     later recovery skip already-compensated records, so undo survives
//     being interrupted by another crash.
func Recover(dir string, opts *Options) (*Report, error) {
	if opts == nil {
		opts = &Options{}
	}
	rep := &Report{}
	lg, err := wal.Open(filepath.Join(dir, "wal.log"))
	if err != nil {
		return nil, err
	}
	defer lg.Close()
	ad, err := pagestore.OpenFileAdapter(filepath.Join(dir, "pages.dat"))
	if err != nil {
		return nil, err
	}
	defer ad.Close()
	st := pagestore.NewStore(ad, lg)
	m := NewManager(lg, st)

	recs, err := wal.Scan(filepath.Join(dir, "wal.log"))
	if err != nil {
		return nil, err
	}
	for _, r := range recs {
		m.recs[r.LSN] = r
	}

	// ---- analysis: transaction table from the durable log ----
	txs := make(map[uint64]*txState)
	for _, r := range recs {
		ts := txs[r.TxID]
		if ts == nil {
			ts = &txState{}
			txs[r.TxID] = ts
		}
		ts.lastLSN = r.LSN
		switch r.Type {
		case wal.RecCommit:
			ts.status = stCommitted
		case wal.RecAbort:
			ts.status = stAborted
		case wal.RecEnd:
			ts.status = stEnded
		}
	}

	// ---- redo: repeat history, committed and uncommitted alike ----
	for _, r := range recs {
		if r.Type != wal.RecUpdate && r.Type != wal.RecCLR {
			continue
		}
		p, err := st.Fetch(r.PageID)
		if err != nil {
			return nil, err
		}
		if p.LSN < r.LSN {
			copy(p.Data, r.After)
			p.LSN = r.LSN
			p.Dirty = true
			rep.Redone++
		}
	}

	// ---- classify transactions ----
	var cands []uint64 // undo candidates: candidate LSNs, one chain head per loser
	for id, ts := range txs {
		switch ts.status {
		case stCommitted:
			rep.Winners = append(rep.Winners, id)
			ts.lastLSN = m.append(&wal.Record{PrevLSN: ts.lastLSN, TxID: id, Type: wal.RecEnd})
		case stRunning, stAborted:
			rep.Losers = append(rep.Losers, id)
			if ts.lastLSN != 0 {
				cands = append(cands, ts.lastLSN)
			}
		}
	}
	sort.Slice(rep.Winners, func(i, j int) bool { return rep.Winners[i] < rep.Winners[j] })
	sort.Slice(rep.Losers, func(i, j int) bool { return rep.Losers[i] < rep.Losers[j] })

	// ---- undo losers, highest LSN first ----
	for len(cands) > 0 {
		best := 0
		for i := range cands {
			if cands[i] > cands[best] {
				best = i
			}
		}
		lsn := cands[best]
		cands = append(cands[:best], cands[best+1:]...)
		rec := m.recs[lsn]
		if rec == nil {
			return nil, fmt.Errorf("db: log record %d referenced but missing", lsn)
		}
		if rec.Type == wal.RecUpdate {
			ts := txs[rec.TxID]
			clrLSN, err := m.writeCLR(rec, ts.lastLSN)
			if err != nil {
				return nil, err
			}
			ts.lastLSN = clrLSN
			rep.CLRs++
			if err := lg.Sync(); err != nil { // undo progress must be durable
				return nil, err
			}
			if opts.FlushOnCLR {
				if err := st.Flush(rec.PageID); err != nil {
					return nil, err
				}
			}
			if opts.CrashAfterCLR > 0 && rep.CLRs >= opts.CrashAfterCLR {
				rep.Crashed = true
				return rep, nil // simulated crash: abandon in-memory state
			}
		}
		if next := nextUndo(rec); next != 0 {
			cands = append(cands, next)
		}
	}

	for _, id := range rep.Losers {
		ts := txs[id]
		ts.lastLSN = m.append(&wal.Record{PrevLSN: ts.lastLSN, TxID: id, Type: wal.RecAbort})
		ts.lastLSN = m.append(&wal.Record{PrevLSN: ts.lastLSN, TxID: id, Type: wal.RecEnd})
	}
	if err := lg.Sync(); err != nil {
		return nil, err
	}
	if err := st.FlushAll(); err != nil {
		return nil, err
	}
	return rep, nil
}
