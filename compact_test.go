package logcompact

import (
	"fmt"
	"math/rand"
	"reflect"
	"strings"
	"testing"
)

// genTrace builds a random transaction log: begins, writes over a small
// keyspace, commits (with monotonically increasing commit versions) and
// aborts. Some transactions are deliberately left pending at the end.
func genTrace(r *rand.Rand, ops int) []Record {
	var log []Record
	var open []uint64
	var lsn, nextTxn, version uint64 = 1, 1, 0
	keys := []string{"a", "b", "c", "d", "e"}
	for i := 0; i < ops; i++ {
		rec := Record{LSN: lsn}
		lsn++
		switch choice := r.Intn(10); {
		case choice < 3 || len(open) == 0:
			rec.TxnID, rec.Kind = nextTxn, Begin
			open = append(open, nextTxn)
			nextTxn++
		case choice < 7:
			rec.TxnID, rec.Kind = open[r.Intn(len(open))], Write
			rec.Key = keys[r.Intn(len(keys))]
			rec.Value = fmt.Sprintf("val@%d", rec.LSN)
		case choice < 9:
			idx := r.Intn(len(open))
			rec.TxnID, rec.Kind = open[idx], Commit
			open = append(open[:idx], open[idx+1:]...)
			version++
			rec.Version = version
		default:
			idx := r.Intn(len(open))
			rec.TxnID, rec.Kind = open[idx], Abort
			open = append(open[:idx], open[idx+1:]...)
		}
		log = append(log, rec)
	}
	return log
}

func maxVersion(log []Record) uint64 {
	var max uint64
	for _, rec := range log {
		if rec.Kind == Commit && rec.Version > max {
			max = rec.Version
		}
	}
	return max
}

func pendingTxns(log []Record) map[uint64]bool {
	closed := map[uint64]bool{}
	seen := map[uint64]bool{}
	for _, rec := range log {
		seen[rec.TxnID] = true
		if rec.Kind == Commit || rec.Kind == Abort {
			closed[rec.TxnID] = true
		}
	}
	out := map[uint64]bool{}
	for id := range seen {
		if !closed[id] {
			out[id] = true
		}
	}
	return out
}

// Random transaction traces, compacted at random horizons with random active
// readers, verified against the full-log recovery model.
func TestCompactRandomTraces(t *testing.T) {
	for seed := int64(0); seed < 100; seed++ {
		r := rand.New(rand.NewSource(seed))
		log := genTrace(r, 300)
		maxV := maxVersion(log)
		if maxV == 0 {
			continue
		}
		horizon := 1 + r.Uint64()%maxV

		reg := NewRegistry(8)
		var handles []Handle
		for i := 0; i < 1+r.Intn(6); i++ {
			h, err := reg.Acquire(1 + r.Uint64()%maxV)
			if err != nil {
				t.Fatal(err)
			}
			handles = append(handles, h)
		}
		snapshots := reg.Snapshots()

		decisions := Compact(log, horizon, snapshots)
		compacted := CompactedLog(decisions)

		// Every record carries an explanation.
		for _, d := range decisions {
			if d.Detail == "" {
				t.Fatalf("seed %d: record %+v has no reason", seed, d.Record)
			}
		}

		// Recovery model: visible state from the compacted log must equal
		// visible state from the full log at the horizon, at every active
		// reader snapshot, and beyond the newest version.
		checkAt := append([]uint64{horizon, maxV + 1}, snapshots...)
		for _, snap := range checkAt {
			want := VisibleState(log, snap)
			got := VisibleState(compacted, snap)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("seed %d: state at snapshot %d differs\nfull:      %v\ncompacted: %v",
					seed, snap, want, got)
			}
		}

		// Pending-transaction recovery dependency: every record of a pending
		// transaction must survive compaction.
		pending := pendingTxns(log)
		keptByLSN := map[uint64]bool{}
		for _, d := range decisions {
			keptByLSN[d.Record.LSN] = d.Kept
		}
		for _, rec := range log {
			if pending[rec.TxnID] && !keptByLSN[rec.LSN] {
				t.Fatalf("seed %d: pending txn %d record lsn=%d dropped", seed, rec.TxnID, rec.LSN)
			}
		}

		// Compaction is a fixpoint: re-compacting the compacted log with the
		// same horizon and readers keeps everything.
		for _, d := range Compact(compacted, horizon, snapshots) {
			if !d.Kept {
				t.Fatalf("seed %d: compaction not idempotent, dropped %s", seed, d)
			}
		}

		_ = handles
	}
}

// Deterministic trace exercising every retention reason, printing the
// per-record report.
func TestCompactReport(t *testing.T) {
	log := []Record{
		{LSN: 1, TxnID: 1, Kind: Begin},
		{LSN: 2, TxnID: 1, Kind: Write, Key: "x", Value: "x1"},
		{LSN: 3, TxnID: 1, Kind: Commit, Version: 1},
		{LSN: 4, TxnID: 2, Kind: Begin},
		{LSN: 5, TxnID: 2, Kind: Write, Key: "x", Value: "x2"},
		{LSN: 6, TxnID: 2, Kind: Commit, Version: 2},
		{LSN: 7, TxnID: 3, Kind: Begin},
		{LSN: 8, TxnID: 3, Kind: Write, Key: "y", Value: "y1"}, // txn 3 stays pending
		{LSN: 9, TxnID: 4, Kind: Begin},
		{LSN: 10, TxnID: 4, Kind: Write, Key: "z", Value: "z1"},
		{LSN: 11, TxnID: 4, Kind: Commit, Version: 3}, // beyond horizon
		{LSN: 12, TxnID: 5, Kind: Begin},
		{LSN: 13, TxnID: 5, Kind: Write, Key: "w", Value: "w1"},
		{LSN: 14, TxnID: 5, Kind: Abort},
	}
	const horizon = 2
	decisions := Compact(log, horizon, []uint64{1}) // reader pinned at snapshot 1
	report := Report(decisions)
	t.Logf("compaction report (horizon=%d, readers=[1]):\n%s", horizon, report)

	wantReason := map[uint64]Reason{
		2:  ReasonVisibleToSnapshot, // x@1 visible to reader at snapshot 1
		5:  ReasonVisibleToSnapshot, // x@2 visible at recovery horizon
		7:  ReasonPendingTxn,
		8:  ReasonPendingTxn,
		9:  ReasonBeyondHorizon,
		10: ReasonBeyondHorizon,
		11: ReasonBeyondHorizon,
	}
	wantDrop := map[uint64]Reason{
		1:  ReasonDropObsoleteMeta,
		3:  ReasonDropObsoleteMeta,
		4:  ReasonDropObsoleteMeta,
		6:  ReasonDropObsoleteMeta,
		12: ReasonDropAborted,
		13: ReasonDropAborted,
		14: ReasonDropAborted,
	}
	for _, d := range decisions {
		if reason, ok := wantReason[d.Record.LSN]; ok {
			if !d.Kept || d.Reason != reason {
				t.Errorf("lsn=%d: got kept=%v reason=%v, want kept reason=%v",
					d.Record.LSN, d.Kept, d.Reason, reason)
			}
		}
		if reason, ok := wantDrop[d.Record.LSN]; ok {
			if d.Kept || d.Reason != reason {
				t.Errorf("lsn=%d: got kept=%v reason=%v, want dropped reason=%v",
					d.Record.LSN, d.Kept, d.Reason, reason)
			}
		}
	}
	if !strings.Contains(report, "active reader snapshot 1") {
		t.Errorf("report missing reader-snapshot reason:\n%s", report)
	}

	// Without the reader at snapshot 1, x@1 becomes superseded by x@2.
	for _, d := range Compact(log, horizon, nil) {
		if d.Record.LSN == 2 && (d.Kept || d.Reason != ReasonDropSuperseded) {
			t.Errorf("x@1 without reader: got kept=%v reason=%v, want dropped superseded",
				d.Kept, d.Reason)
		}
	}
}
