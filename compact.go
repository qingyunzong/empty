package logcompact

import (
	"fmt"
	"sort"
	"strings"
)

// Reason classifies why a record was kept or dropped during compaction.
type Reason int

const (
	// ReasonPendingTxn: the record belongs to a transaction that has neither
	// committed nor aborted; it is required for recovery/rollback.
	ReasonPendingTxn Reason = iota
	// ReasonBeyondHorizon: the record's commit version is beyond the
	// compaction horizon and must survive untouched.
	ReasonBeyondHorizon
	// ReasonVisibleToSnapshot: the record is the visible version of its key
	// at the recovery horizon or at an active reader's snapshot.
	ReasonVisibleToSnapshot
	// ReasonDropSuperseded: a newer committed version of the same key serves
	// the horizon and every active reader snapshot.
	ReasonDropSuperseded
	// ReasonDropAborted: the record belongs to an aborted transaction.
	ReasonDropAborted
	// ReasonDropObsoleteMeta: begin/commit metadata of a transaction whose
	// commit version is at or below the horizon; writes carry resolved
	// versions in the compacted log, so the metadata is no longer needed.
	ReasonDropObsoleteMeta
)

// Decision is the compaction verdict for one record, with a human-readable
// explanation.
type Decision struct {
	Record Record
	Kept   bool
	Reason Reason
	Detail string
}

func (d Decision) String() string {
	action := "DROP"
	if d.Kept {
		action = "KEEP"
	}
	return fmt.Sprintf("%s lsn=%d txn=%d kind=%s key=%q ver=%d reason=%s",
		action, d.Record.LSN, d.Record.TxnID, d.Record.Kind, d.Record.Key,
		d.Record.Version, d.Detail)
}

// Compact decides the fate of every record in log when compacting to the
// given commit-version horizon. readerSnapshots are the snapshots pinned by
// active readers (see Registry.Snapshots). The horizon itself is treated as
// an implicit snapshot: state visible at the horizon must remain
// reconstructible for recovery.
//
// A record is kept iff at least one holds:
//   - its transaction is still pending (recovery dependency);
//   - its commit version is beyond the horizon;
//   - it is the visible version of its key at the horizon or at some active
//     reader snapshot.
func Compact(log []Record, horizon uint64, readerSnapshots []uint64) []Decision {
	committed := map[uint64]uint64{} // txn -> commit version
	aborted := map[uint64]bool{}
	seen := map[uint64]bool{}
	for _, rec := range log {
		seen[rec.TxnID] = true
		switch rec.Kind {
		case Commit:
			committed[rec.TxnID] = rec.Version
		case Abort:
			aborted[rec.TxnID] = true
		}
	}
	pending := map[uint64]bool{}
	for id := range seen {
		if _, ok := committed[id]; !ok && !aborted[id] {
			pending[id] = true
		}
	}

	// Sorted, de-duplicated committed write versions per key.
	versionsByKey := map[string][]uint64{}
	for _, rec := range log {
		if rec.Kind != Write {
			continue
		}
		v, ok := committed[rec.TxnID]
		if !ok {
			continue
		}
		versionsByKey[rec.Key] = append(versionsByKey[rec.Key], v)
	}
	for key := range versionsByKey {
		vs := versionsByKey[key]
		sort.Slice(vs, func(i, j int) bool { return vs[i] < vs[j] })
		uniq := vs[:0]
		for _, v := range vs {
			if len(uniq) == 0 || uniq[len(uniq)-1] != v {
				uniq = append(uniq, v)
			}
		}
		versionsByKey[key] = uniq
	}

	visibleAt := func(key string, snapshot uint64) (uint64, bool) {
		vs := versionsByKey[key]
		i := sort.Search(len(vs), func(i int) bool { return vs[i] > snapshot }) - 1
		if i < 0 {
			return 0, false
		}
		return vs[i], true
	}

	type snapshotReq struct {
		version uint64
		label   string
	}
	reqs := []snapshotReq{{horizon, fmt.Sprintf("recovery horizon %d", horizon)}}
	for _, s := range readerSnapshots {
		reqs = append(reqs, snapshotReq{s, fmt.Sprintf("active reader snapshot %d", s)})
	}

	decisions := make([]Decision, 0, len(log))
	for _, rec := range log {
		d := Decision{Record: rec}
		switch {
		case pending[rec.TxnID]:
			d.Kept, d.Reason = true, ReasonPendingTxn
			d.Detail = fmt.Sprintf("txn %d neither committed nor aborted; required for pending-transaction recovery", rec.TxnID)
		case aborted[rec.TxnID]:
			d.Kept, d.Reason = false, ReasonDropAborted
			d.Detail = fmt.Sprintf("txn %d aborted; its records are unreachable", rec.TxnID)
		default: // committed transaction
			version := committed[rec.TxnID]
			switch rec.Kind {
			case Write:
				d.Record.Version = version // resolve version for the compacted log
				if version > horizon {
					d.Kept, d.Reason = true, ReasonBeyondHorizon
					d.Detail = fmt.Sprintf("commit version %d is beyond compaction horizon %d", version, horizon)
					break
				}
				var servedBy []string
				for _, req := range reqs {
					if vis, ok := visibleAt(rec.Key, req.version); ok && vis == version {
						servedBy = append(servedBy, req.label)
					}
				}
				if len(servedBy) > 0 {
					d.Kept, d.Reason = true, ReasonVisibleToSnapshot
					d.Detail = fmt.Sprintf("version %d of key %q is the visible version at %s",
						version, rec.Key, strings.Join(servedBy, ", "))
				} else {
					next := versionsByKey[rec.Key][sort.Search(len(versionsByKey[rec.Key]),
						func(i int) bool { return versionsByKey[rec.Key][i] > version })]
					d.Kept, d.Reason = false, ReasonDropSuperseded
					d.Detail = fmt.Sprintf("version %d of key %q superseded by version %d at the horizon and every active reader snapshot",
						version, rec.Key, next)
				}
			case Commit:
				if version > horizon {
					d.Kept, d.Reason = true, ReasonBeyondHorizon
					d.Detail = fmt.Sprintf("commit version %d is beyond compaction horizon %d", version, horizon)
				} else {
					d.Kept, d.Reason = false, ReasonDropObsoleteMeta
					d.Detail = fmt.Sprintf("commit of txn %d at version %d <= horizon %d; writes carry resolved versions",
						rec.TxnID, version, horizon)
				}
			default: // Begin of a committed transaction
				if version > horizon {
					d.Kept, d.Reason = true, ReasonBeyondHorizon
					d.Detail = fmt.Sprintf("commit version %d is beyond compaction horizon %d", version, horizon)
				} else {
					d.Kept, d.Reason = false, ReasonDropObsoleteMeta
					d.Detail = fmt.Sprintf("begin of txn %d committed at version %d <= horizon %d; no recovery value",
						rec.TxnID, version, horizon)
				}
			}
		}
		decisions = append(decisions, d)
	}
	return decisions
}

// CompactedLog extracts the kept records from decisions, in original order.
func CompactedLog(decisions []Decision) []Record {
	var out []Record
	for _, d := range decisions {
		if d.Kept {
			out = append(out, d.Record)
		}
	}
	return out
}

// Report renders one line per record explaining why it was kept or dropped.
func Report(decisions []Decision) string {
	var b strings.Builder
	kept, dropped := 0, 0
	for _, d := range decisions {
		fmt.Fprintf(&b, "%s\n", d)
		if d.Kept {
			kept++
		} else {
			dropped++
		}
	}
	fmt.Fprintf(&b, "kept=%d dropped=%d\n", kept, dropped)
	return b.String()
}

// VisibleState reconstructs the committed key/value state visible at the
// given snapshot version. It works on both full logs (versions resolved from
// Commit records) and compacted logs (versions resolved onto Write records).
func VisibleState(log []Record, snapshot uint64) map[string]string {
	committed := map[uint64]uint64{}
	for _, rec := range log {
		if rec.Kind == Commit {
			committed[rec.TxnID] = rec.Version
		}
	}
	type versionedValue struct {
		version uint64
		value   string
	}
	best := map[string]versionedValue{}
	for _, rec := range log {
		if rec.Kind != Write {
			continue
		}
		version := rec.Version
		if version == 0 {
			version = committed[rec.TxnID]
		}
		if version == 0 || version > snapshot {
			continue
		}
		if cur, ok := best[rec.Key]; !ok || version >= cur.version {
			best[rec.Key] = versionedValue{version, rec.Value}
		}
	}
	state := make(map[string]string, len(best))
	for key, vv := range best {
		state[key] = vv.value
	}
	return state
}
