package logcompact_test

import (
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"testing"

	"logcompact"
)

// TestRandomTracesMatchFullLogModel drives random transaction workloads
// with interleaved reader acquire/release and compaction, and after every
// compaction verifies the compacted log against the full-log model:
// committed state, pending transaction chains, and reader snapshots must
// all be identical.
func TestRandomTracesMatchFullLogModel(t *testing.T) {
	for seed := int64(1); seed <= 40; seed++ {
		seed := seed
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			runTrace(t, seed)
		})
	}
}

func runTrace(t *testing.T, seed int64) {
	t.Helper()
	rng := rand.New(rand.NewSource(seed))
	l := logcompact.New()
	reg := logcompact.NewReaderRegistry()
	var full []logcompact.Record
	var openTxns []uint64
	var readers, stale []logcompact.ReaderToken
	keys := []string{"alpha", "beta", "gamma", "delta"}

	verify := func(step int) {
		t.Helper()
		if got := reg.Active(); got != len(readers) {
			t.Fatalf("step %d: registry holds %d readers, test tracks %d (stale release leaked?)", step, got, len(readers))
		}
		got := logcompact.Recover(l.Records())
		want := logcompact.Recover(full)
		if !reflect.DeepEqual(got.State, want.State) {
			t.Fatalf("step %d: committed state mismatch\n got: %v\nwant: %v", step, got.State, want.State)
		}
		if !reflect.DeepEqual(got.Pending, want.Pending) {
			t.Fatalf("step %d: pending txn chains mismatch\n got: %v\nwant: %v", step, got.Pending, want.Pending)
		}
		for txn, chain := range got.Pending {
			for i := 1; i < len(chain); i++ {
				if chain[i].PrevLSN != chain[i-1].LSN {
					t.Fatalf("step %d: pending txn %d has broken PrevLSN chain: %+v", step, txn, chain)
				}
			}
		}
		for _, tok := range readers {
			gotSnap := logcompact.ReadSnapshot(l.Records(), tok.Snapshot)
			wantSnap := logcompact.ReadSnapshot(full, tok.Snapshot)
			if !reflect.DeepEqual(gotSnap, wantSnap) {
				t.Fatalf("step %d: reader snapshot %d mismatch\n got: %v\nwant: %v", step, tok.Snapshot, gotSnap, wantSnap)
			}
		}
	}

	checkReport := func(step int, rep logcompact.Report, horizon uint64) {
		t.Helper()
		records := l.Records()
		if len(rep.Kept) != len(records) {
			t.Fatalf("step %d: report keeps %d, log holds %d", step, len(rep.Kept), len(records))
		}
		for i, k := range rep.Kept {
			if k.Record != records[i] {
				t.Fatalf("step %d: kept record %d out of order", step, i)
			}
			if k.Reasons == 0 {
				t.Fatalf("step %d: kept record %+v has no retention reason", step, k.Record)
			}
		}
		for _, d := range rep.Dropped {
			if d.LSN > horizon {
				t.Fatalf("step %d: dropped record above horizon: %+v", step, d)
			}
		}
	}

	for step := 0; step < 400; step++ {
		op := rng.Intn(100)
		switch {
		case op < 15: // begin
			id, rec := l.Begin()
			openTxns = append(openTxns, id)
			full = append(full, rec)
		case op < 55: // update
			if len(openTxns) == 0 {
				continue
			}
			txn := openTxns[rng.Intn(len(openTxns))]
			rec, err := l.Update(txn, keys[rng.Intn(len(keys))], fmt.Sprintf("v%d", step))
			if err != nil {
				t.Fatalf("step %d: update: %v", step, err)
			}
			full = append(full, rec)
		case op < 70: // commit
			if len(openTxns) == 0 {
				continue
			}
			i := rng.Intn(len(openTxns))
			rec, err := l.Commit(openTxns[i])
			if err != nil {
				t.Fatalf("step %d: commit: %v", step, err)
			}
			openTxns = append(openTxns[:i], openTxns[i+1:]...)
			full = append(full, rec)
		case op < 80: // abort
			if len(openTxns) == 0 {
				continue
			}
			i := rng.Intn(len(openTxns))
			rec, err := l.Abort(openTxns[i])
			if err != nil {
				t.Fatalf("step %d: abort: %v", step, err)
			}
			openTxns = append(openTxns[:i], openTxns[i+1:]...)
			full = append(full, rec)
		case op < 88: // acquire reader
			readers = append(readers, reg.Acquire(l.LastLSN()))
		case op < 94: // release reader (sometimes with a stale token)
			if len(stale) > 0 && rng.Intn(10) < 4 {
				tok := stale[rng.Intn(len(stale))]
				if err := reg.Release(tok); !errors.Is(err, logcompact.ErrStaleRelease) {
					t.Fatalf("step %d: stale release: got %v, want ErrStaleRelease", step, err)
				}
				if got := reg.Active(); got != len(readers) {
					t.Fatalf("step %d: stale release removed an active reader", step)
				}
				continue
			}
			if len(readers) == 0 {
				continue
			}
			i := rng.Intn(len(readers))
			tok := readers[i]
			readers = append(readers[:i], readers[i+1:]...)
			if err := reg.Release(tok); err != nil {
				t.Fatalf("step %d: release: %v", step, err)
			}
			stale = append(stale, tok)
		default: // compact to a random commit version
			var eligible []uint64
			for _, c := range l.Commits() {
				if c >= l.Horizon() {
					eligible = append(eligible, c)
				}
			}
			if len(eligible) == 0 {
				continue
			}
			horizon := eligible[rng.Intn(len(eligible))]
			rep, err := l.Compact(horizon, reg)
			if err != nil {
				t.Fatalf("step %d: compact(%d): %v", step, horizon, err)
			}
			checkReport(step, rep, horizon)
			verify(step)
		}
	}

	// Final drain: compact to the newest commit version and verify once more.
	if mc := l.MaxCommit(); mc > 0 && mc >= l.Horizon() {
		rep, err := l.Compact(mc, reg)
		if err != nil {
			t.Fatalf("final compact(%d): %v", mc, err)
		}
		checkReport(-1, rep, mc)
	}
	verify(-1)
	t.Logf("seed=%d final: full=%d records, compacted=%d records, readers=%d",
		seed, len(full), len(l.Records()), reg.Active())
}
