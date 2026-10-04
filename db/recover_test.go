package db_test

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"pagedb/db"
	"pagedb/pagestore"
	"pagedb/wal"
)

const victimPage = 0

// fate is the outcome of one transaction at the moment of the crash.
type fate byte

const (
	fCommit fate = 'C' // committed before the crash
	fAbort  fate = 'A' // aborted before the crash
	fActive fate = 'X' // still active (uncommitted) at the crash
	fSkip   fate = '-' // never started (crash happened earlier)
)

func txValue(i int) []byte {
	return []byte(fmt.Sprintf("page-value-from-tx-%d", i+1))
}

// build replays a three-transaction scenario against a fresh directory
// and then simulates a crash: everything not explicitly synced (log) or
// flushed (page) is lost. It returns the highest LSN the scenario
// appended, so callers can enumerate per-record flush boundaries.
//
//	fates:      commit / abort / active-at-crash / never-started, per tx
//	flushEvery: steal the page to disk after every single log record
//	flushAtLSN: steal the page immediately after this log record
func build(t *testing.T, dir string, fates [3]fate, flushEvery bool, flushAtLSN uint64) uint64 {
	t.Helper()
	lg, err := wal.Open(filepath.Join(dir, "wal.log"))
	if err != nil {
		t.Fatal(err)
	}
	ad, err := pagestore.OpenFileAdapter(filepath.Join(dir, "pages.dat"))
	if err != nil {
		t.Fatal(err)
	}
	st := pagestore.NewStore(ad, lg)
	m := db.NewManager(lg, st)
	m.SetAppendHook(func(lsn uint64) {
		if flushEvery || lsn == flushAtLSN {
			if err := st.Flush(victimPage); err != nil {
				t.Fatal(err)
			}
		}
	})
	for i := 0; i < 3; i++ {
		f := fates[i]
		if f == fSkip {
			break
		}
		tx := m.Begin()
		if err := tx.Write(victimPage, txValue(i)); err != nil {
			t.Fatal(err)
		}
		switch f {
		case fCommit:
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
		case fAbort:
			if err := tx.Abort(); err != nil {
				t.Fatal(err)
			}
		}
	}
	maxLSN := lg.NextLSN() - 1
	// Crash: the unsynced log tail and unflushed dirty pages are lost.
	if err := lg.Close(); err != nil {
		t.Fatal(err)
	}
	if err := ad.Close(); err != nil {
		t.Fatal(err)
	}
	return maxLSN
}

// expectedPage computes the only correct post-recovery page image: the
// writes of all committed transactions, in order, on a zero page.
func expectedPage(fates [3]fate) []byte {
	want := make([]byte, pagestore.PageSize)
	for i := 0; i < 3; i++ {
		switch fates[i] {
		case fCommit:
			copy(want, txValue(i))
		case fActive, fSkip:
			return want
		}
	}
	return want
}

// allFates enumerates every physically possible fate combination. Page
// locks are held to commit, so writers of one page are serialized: at
// most one transaction may be active at the crash, and nothing starts
// after it (or after a skipped transaction).
func allFates() [][3]fate {
	fates := []fate{fCommit, fAbort, fActive, fSkip}
	var out [][3]fate
	for _, a := range fates {
		for _, b := range fates {
			for _, c := range fates {
				f := [3]fate{a, b, c}
				if validFates(f) {
					out = append(out, f)
				}
			}
		}
	}
	return out
}

func validFates(f [3]fate) bool {
	active, skipped := false, false
	for _, x := range f {
		if skipped && x != fSkip {
			return false
		}
		if active && x != fSkip {
			return false
		}
		switch x {
		case fActive:
			active = true
		case fSkip:
			skipped = true
		}
	}
	return true
}

func assertPage(t *testing.T, dir string, want []byte) {
	t.Helper()
	ad, err := pagestore.OpenFileAdapter(filepath.Join(dir, "pages.dat"))
	if err != nil {
		t.Fatal(err)
	}
	defer ad.Close()
	_, got, err := ad.ReadPage(victimPage)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("page = %q..., want %q...", got[:24], want[:24])
	}
}

// TestThreeTxSamePageExhaustive sweeps the full persistence-boundary
// matrix of three transactions writing the same page:
//
//   - every fate combination (commit / abort / active / never-started);
//   - every steal boundary: page never flushed, flushed after every
//     operation, or flushed at exactly one log-record boundary;
//   - log durability follows from the WAL rule (flush forces a sync),
//     so unsynced log tails are lost at the crash.
//
// For every cell it asserts that recovery leaves exactly the committed
// prefix on the page, and that a second recovery is a complete no-op.
func TestThreeTxSamePageExhaustive(t *testing.T) {
	for _, fates := range allFates() {
		// Learn the scenario's max LSN with a dry run.
		dry := t.TempDir()
		maxLSN := build(t, dry, fates, false, 0)
		type variant struct {
			name  string
			every bool
			at    uint64
		}
		variants := []variant{
			{name: "flush-never"},
			{name: "flush-always", every: true},
		}
		for k := uint64(1); k <= maxLSN; k++ {
			variants = append(variants, variant{name: fmt.Sprintf("flush-at-LSN-%d", k), at: k})
		}
		for _, v := range variants {
			name := fmt.Sprintf("%c%c%c/%s", fates[0], fates[1], fates[2], v.name)
			t.Run(name, func(t *testing.T) {
				dir := t.TempDir()
				build(t, dir, fates, v.every, v.at)
				rep, err := db.Recover(dir, nil)
				if err != nil {
					t.Fatalf("recover: %v", err)
				}
				if rep.Crashed {
					t.Fatal("unexpected simulated crash")
				}
				want := expectedPage(fates)
				assertPage(t, dir, want)
				// Recovery must be idempotent: a second run changes
				// neither the page nor the log.
				walBefore, err := os.ReadFile(filepath.Join(dir, "wal.log"))
				if err != nil {
					t.Fatal(err)
				}
				rep2, err := db.Recover(dir, nil)
				if err != nil {
					t.Fatalf("re-recover: %v", err)
				}
				if rep2.Redone != 0 || rep2.CLRs != 0 || len(rep2.Losers) != 0 {
					t.Fatalf("second recovery not a no-op: %+v", rep2)
				}
				walAfter, err := os.ReadFile(filepath.Join(dir, "wal.log"))
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(walBefore, walAfter) {
					t.Fatal("second recovery appended to the log")
				}
				assertPage(t, dir, want)
			})
		}
	}
}

// TestCrashDuringUndoIdempotent interrupts undo itself: recovery is
// crashed after every single CLR, over and over, until it converges.
// Undo must still finish correctly and leave a state that further
// recovery runs do not modify. The matrix crosses whether the
// uncommitted page was stolen to disk before the crash with whether
// compensated pages are stolen during undo.
func TestCrashDuringUndoIdempotent(t *testing.T) {
	for _, stealPage := range []bool{false, true} {
		for _, flushCLR := range []bool{false, true} {
			name := fmt.Sprintf("stealPage=%v/stealCLRPage=%v", stealPage, flushCLR)
			t.Run(name, func(t *testing.T) {
				dir := t.TempDir()
				lg, err := wal.Open(filepath.Join(dir, "wal.log"))
				if err != nil {
					t.Fatal(err)
				}
				ad, err := pagestore.OpenFileAdapter(filepath.Join(dir, "pages.dat"))
				if err != nil {
					t.Fatal(err)
				}
				st := pagestore.NewStore(ad, lg)
				m := db.NewManager(lg, st)
				tx := m.Begin()
				for i := 0; i < 3; i++ {
					if err := tx.Write(victimPage, txValue(i)); err != nil {
						t.Fatal(err)
					}
				}
				if stealPage {
					if err := st.Flush(victimPage); err != nil { // steal uncommitted page
						t.Fatal(err)
					}
				} else if err := lg.Sync(); err != nil { // log durable, page not
					t.Fatal(err)
				}
				if err := lg.Close(); err != nil { // crash with an active loser
					t.Fatal(err)
				}
				if err := ad.Close(); err != nil {
					t.Fatal(err)
				}
				// Crash recovery after every single CLR until it converges.
				converged := false
				for round := 0; round < 16 && !converged; round++ {
					rep, err := db.Recover(dir, &db.Options{CrashAfterCLR: 1, FlushOnCLR: flushCLR})
					if err != nil {
						t.Fatalf("recovery round %d: %v", round, err)
					}
					converged = !rep.Crashed
				}
				if !converged {
					t.Fatal("recovery did not converge after 16 crash rounds")
				}
				assertPage(t, dir, make([]byte, pagestore.PageSize))
				// A final plain recovery must be a no-op.
				rep, err := db.Recover(dir, nil)
				if err != nil {
					t.Fatal(err)
				}
				if rep.Redone != 0 || rep.CLRs != 0 || len(rep.Losers) != 0 {
					t.Fatalf("not idempotent after crash storm: %+v", rep)
				}
				assertPage(t, dir, make([]byte, pagestore.PageSize))
			})
		}
	}
}
