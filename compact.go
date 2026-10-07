package logcompact

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Reason is a bitmask explaining why a record survived compaction.
type Reason uint16

const (
	// ReasonBeyondHorizon: the record's LSN is above the compaction
	// horizon and therefore not eligible for removal.
	ReasonBeyondHorizon Reason = 1 << iota
	// ReasonCheckpointBase: the record is the newest committed update
	// for its key visible at the horizon; it carries the committed
	// state that recovery would otherwise reconstruct from the full log.
	ReasonCheckpointBase
	// ReasonActiveReader: the record is the newest committed update for
	// its key visible at a snapshot pinned by an active reader.
	ReasonActiveReader
	// ReasonPendingTxnRecovery: the record belongs to a transaction
	// whose outcome (commit/abort) lies above the horizon or has not
	// happened yet; recovery still needs the full record chain.
	ReasonPendingTxnRecovery
	// ReasonCommitMarker: commit record of a transaction whose update
	// records are retained; recovery needs it to apply those updates.
	ReasonCommitMarker
)

var reasonNames = []struct {
	flag Reason
	name string
}{
	{ReasonBeyondHorizon, "beyond-horizon"},
	{ReasonCheckpointBase, "checkpoint-base"},
	{ReasonActiveReader, "active-reader"},
	{ReasonPendingTxnRecovery, "pending-txn-recovery"},
	{ReasonCommitMarker, "commit-marker"},
}

// Strings lists the individual reason names set in the mask.
func (r Reason) Strings() []string {
	var out []string
	for _, rn := range reasonNames {
		if r&rn.flag != 0 {
			out = append(out, rn.name)
		}
	}
	return out
}

func (r Reason) String() string {
	return strings.Join(r.Strings(), "|")
}

// KeptRecord pairs a retained record with its retention reasons.
type KeptRecord struct {
	Record  Record
	Reasons Reason
}

// Report describes the outcome of one compaction: every retained record
// with its reasons, and every dropped record.
type Report struct {
	Horizon uint64
	Kept    []KeptRecord
	Dropped []Record
}

// ReasonsFor returns the retention reasons of a kept LSN (0 if dropped).
func (r *Report) ReasonsFor(lsn uint64) Reason {
	for _, k := range r.Kept {
		if k.Record.LSN == lsn {
			return k.Reasons
		}
	}
	return 0
}

func formatRecord(rec Record) string {
	s := fmt.Sprintf("lsn=%d txn=%d type=%s", rec.LSN, rec.TxnID, rec.Type)
	if rec.Type == UpdateRecord {
		s += fmt.Sprintf(" key=%s value=%s", rec.Key, rec.Value)
	}
	return s
}

// String renders one line per retained record with its reasons, followed
// by one line per dropped record.
func (r *Report) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "horizon=%d kept=%d dropped=%d\n", r.Horizon, len(r.Kept), len(r.Dropped))
	for _, k := range r.Kept {
		fmt.Fprintf(&b, "keep %s reasons=%s\n", formatRecord(k.Record), k.Reasons)
	}
	for _, d := range r.Dropped {
		fmt.Fprintf(&b, "drop %s\n", formatRecord(d))
	}
	return b.String()
}

// ErrInvalidHorizon is returned when the compaction target is not a
// commit version known to the log, or moves the horizon backwards.
var ErrInvalidHorizon = errors.New("logcompact: invalid compaction horizon")

// Compact drops every record at or below horizon that is not needed by
// crash recovery or by any active reader in reg (reg may be nil).
// horizon must be a commit version produced by Commit and must not move
// backwards. The returned Report lists each retained record's reasons.
func (l *Log) Compact(horizon uint64, reg *ReaderRegistry) (Report, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	idx := sort.Search(len(l.commits), func(i int) bool { return l.commits[i] >= horizon })
	if idx == len(l.commits) || l.commits[idx] != horizon || horizon < l.horizon {
		return Report{}, fmt.Errorf("%w: %d", ErrInvalidHorizon, horizon)
	}

	reasons := map[uint64]Reason{}
	mark := func(lsn uint64, why Reason) { reasons[lsn] |= why }

	// Committed updates at or below the horizon, grouped by key.
	byKey := map[string][]Record{}
	for _, rec := range l.records {
		if rec.Type == UpdateRecord && rec.LSN <= horizon {
			if _, ok := l.commitAt[rec.TxnID]; ok {
				byKey[rec.Key] = append(byKey[rec.Key], rec)
			}
		}
	}
	// visibleAt returns, per key, the newest update whose transaction
	// committed at or below point p.
	visibleAt := func(p uint64) []Record {
		var out []Record
		for _, recs := range byKey {
			var best Record
			found := false
			for _, rec := range recs {
				if rec.LSN <= p && l.commitAt[rec.TxnID] <= p && (!found || rec.LSN > best.LSN) {
					best, found = rec, true
				}
			}
			if found {
				out = append(out, best)
			}
		}
		return out
	}

	// Checkpoint base: committed state visible at the horizon.
	for _, rec := range visibleAt(horizon) {
		mark(rec.LSN, ReasonCheckpointBase)
	}
	// Active readers: state visible at each pinned snapshot.
	if reg != nil {
		for _, snap := range reg.Snapshots() {
			p := snap
			if p > horizon {
				p = horizon
			}
			for _, rec := range visibleAt(p) {
				mark(rec.LSN, ReasonActiveReader)
			}
		}
	}
	// Transactions unresolved at the horizon: keep the whole chain.
	for _, rec := range l.records {
		committed := l.commitAt[rec.TxnID] > 0 && l.commitAt[rec.TxnID] <= horizon
		aborted := l.abortAt[rec.TxnID] > 0 && l.abortAt[rec.TxnID] <= horizon
		if !committed && !aborted {
			mark(rec.LSN, ReasonPendingTxnRecovery)
		}
	}
	// Records above the horizon are never eligible for removal.
	for _, rec := range l.records {
		if rec.LSN > horizon {
			mark(rec.LSN, ReasonBeyondHorizon)
		}
	}
	// Commit markers for retained committed updates.
	for _, rec := range l.records {
		if rec.Type == UpdateRecord && reasons[rec.LSN] != 0 {
			if clsn := l.commitAt[rec.TxnID]; clsn > 0 && clsn <= horizon {
				mark(clsn, ReasonCommitMarker)
			}
		}
	}

	rep := Report{Horizon: horizon}
	kept := make([]Record, 0, len(l.records))
	for _, rec := range l.records {
		if why := reasons[rec.LSN]; why != 0 {
			rep.Kept = append(rep.Kept, KeptRecord{Record: rec, Reasons: why})
			kept = append(kept, rec)
		} else {
			rep.Dropped = append(rep.Dropped, rec)
		}
	}
	l.records = kept
	l.horizon = horizon
	return rep, nil
}
