package db_test

import (
	"bytes"
	"fmt"
	"testing"

	"pagestore/db"
	"pagestore/fileadapter"
)

// Three transactions T1..T3 write disjoint 128-byte regions of the same
// page. The test exhaustively enumerates the persistence boundaries:
//   - which transactions commit (the rest abort): 8 masks
//   - the crash point: after each prefix of the 6 operations
//   - whether the dirty page was stolen to disk after each write
//
// After every simulated crash, recovery must leave each region holding
// the value of its transaction iff that transaction committed, and the
// initial zeros otherwise. Recovery is then run twice more (once in the
// same process, once after reopen) to prove idempotency.
const (
	pageID    = 0
	regionLen = 128
)

var regionOff = []int{0, 128, 256}

func regionVal(txn int) []byte {
	return bytes.Repeat([]byte{byte('A' + txn)}, regionLen)
}

// op is one step of the workload: writes first, then commit/abort per txn.
type op struct {
	write bool // true: txn writes its region; false: txn commits or aborts
	txn   int
}

var workload = []op{
	{true, 0}, {true, 1}, {true, 2}, // T1,T2,T3 write the page
	{false, 0}, {false, 1}, {false, 2}, // T1,T2,T3 commit or abort
}

// runCrash executes the first crashAfter ops with the given commit mask,
// stealing the page to disk right after the flushAfter-th write
// (0 = never), then crashes (closes without flushing anything).
func runCrash(t *testing.T, dir string, mask, crashAfter, flushAfter int) {
	t.Helper()
	d, err := db.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	txns := []uint64{d.Begin(), d.Begin(), d.Begin()}
	writes := 0
	for i := 0; i < crashAfter; i++ {
		o := workload[i]
		if o.write {
			if err := d.Write(txns[o.txn], pageID, regionOff[o.txn], regionVal(o.txn)); err != nil {
				t.Fatal(err)
			}
			writes++
			if writes == flushAfter {
				if err := d.FlushPage(pageID); err != nil { // steal uncommitted page
					t.Fatal(err)
				}
			}
		} else if mask&(1<<o.txn) != 0 {
			if err := d.Commit(txns[o.txn]); err != nil {
				t.Fatal(err)
			}
		} else {
			if err := d.Abort(txns[o.txn]); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := d.Close(); err != nil { // crash: unflushed log and dirty pages vanish
		t.Fatal(err)
	}
}

// wantPage computes the expected post-recovery page image.
func wantPage(mask, crashAfter int) []byte {
	want := make([]byte, fileadapter.PageSize)
	for txn := 0; txn < 3; txn++ {
		wrote := crashAfter > txn      // write op for txn is at index txn
		finished := crashAfter > 3+txn // finish op for txn is at index 3+txn
		committed := finished && mask&(1<<txn) != 0
		if wrote && committed {
			copy(want[db.PageHeaderLen+regionOff[txn]:], regionVal(txn))
		}
	}
	return want
}

func wantWinners(mask, crashAfter int) []uint64 {
	var winners []uint64
	for txn := 0; txn < 3; txn++ {
		if crashAfter > 3+txn && mask&(1<<txn) != 0 {
			winners = append(winners, uint64(txn+1))
		}
	}
	return winners
}

func checkRecovered(t *testing.T, dir string, mask, crashAfter int) {
	t.Helper()
	d, err := db.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	rep, err := d.Recover(db.RecoverOptions{})
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	want := wantPage(mask, crashAfter)
	got, err := d.ReadPage(pageID)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got[db.PageHeaderLen:], want[db.PageHeaderLen:]) {
		t.Fatalf("page mismatch after recovery\n got: %.32q...\nwant: %.32q...",
			got[db.PageHeaderLen:], want[db.PageHeaderLen:])
	}
	if fmt.Sprint(rep.Winners) != fmt.Sprint(wantWinners(mask, crashAfter)) {
		t.Fatalf("winners = %v, want %v", rep.Winners, wantWinners(mask, crashAfter))
	}

	// Idempotency: a second recovery in the same process is a no-op.
	rep2, err := d.Recover(db.RecoverOptions{})
	if err != nil {
		t.Fatalf("second recover: %v", err)
	}
	if rep2.Redone != 0 || rep2.CLRsWritten != 0 || len(rep2.Losers) != 0 {
		t.Fatalf("second recovery not a no-op: %+v", rep2)
	}
	got2, err := d.ReadPage(pageID)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got2, got) {
		t.Fatal("page changed under repeated recovery")
	}
}

func TestThreeTxnsSamePage_ExhaustiveBoundaries(t *testing.T) {
	scenarios := 0
	for mask := 0; mask < 8; mask++ {
		for crashAfter := 0; crashAfter <= len(workload); crashAfter++ {
			writesBeforeCrash := crashAfter
			if writesBeforeCrash > 3 {
				writesBeforeCrash = 3
			}
			for flushAfter := 0; flushAfter <= writesBeforeCrash; flushAfter++ {
				mask, crashAfter, flushAfter := mask, crashAfter, flushAfter
				name := fmt.Sprintf("mask=%03b/crashAfter=%d/flushAfter=%d", mask, crashAfter, flushAfter)
				t.Run(name, func(t *testing.T) {
					dir := t.TempDir()
					runCrash(t, dir, mask, crashAfter, flushAfter)
					checkRecovered(t, dir, mask, crashAfter)
					// Idempotency across a process restart as well.
					checkRecoveredNoop(t, dir)
				})
				scenarios++
			}
		}
	}
	t.Logf("exercised %d crash/persistence scenarios", scenarios)
}

// checkRecoveredNoop reopens the store and verifies recovery is a no-op.
func checkRecoveredNoop(t *testing.T, dir string) {
	t.Helper()
	d, err := db.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	before, err := d.ReadPage(pageID)
	if err != nil {
		t.Fatal(err)
	}
	rep, err := d.Recover(db.RecoverOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Redone != 0 || rep.CLRsWritten != 0 || len(rep.Losers) != 0 {
		t.Fatalf("recovery after clean recovery not a no-op: %+v", rep)
	}
	after, err := d.ReadPage(pageID)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("page changed under no-op recovery")
	}
}

// TestUndoInterruptedIsIdempotent crashes recovery in the middle of the
// undo phase, repeatedly, and verifies the final result is still correct:
// undoing the undo's interruption must not undo anything twice.
func TestUndoInterruptedIsIdempotent(t *testing.T) {
	// All three transactions crash uncommitted with their log records
	// durable (the log is flushed, the page only per flushAfter):
	// recovery owes 3 CLRs.
	setup := func(t *testing.T, dir string, flushAfter int) {
		t.Helper()
		d, err := db.Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		txns := []uint64{d.Begin(), d.Begin(), d.Begin()}
		for i := 0; i < 3; i++ {
			if err := d.Write(txns[i], pageID, regionOff[i], regionVal(i)); err != nil {
				t.Fatal(err)
			}
			if flushAfter == i+1 {
				if err := d.FlushPage(pageID); err != nil { // steal dirty page
					t.Fatal(err)
				}
			}
		}
		if err := d.FlushLog(); err != nil { // loser records reach disk
			t.Fatal(err)
		}
		if err := d.Close(); err != nil { // crash
			t.Fatal(err)
		}
	}

	t.Run("crash_after_each_clr_count", func(t *testing.T) {
		for n := 1; n <= 3; n++ {
			n := n
			t.Run(fmt.Sprintf("clrs=%d", n), func(t *testing.T) {
				dir := t.TempDir()
				setup(t, dir, 1) // dirty page stolen to disk before crash

				d1, err := db.Open(dir)
				if err != nil {
					t.Fatal(err)
				}
				_, err = d1.Recover(db.RecoverOptions{CrashAfterCLRs: n})
				if err != db.ErrSimulatedCrash {
					t.Fatalf("want simulated crash, got %v", err)
				}
				d1.Close()

				d2, err := db.Open(dir)
				if err != nil {
					t.Fatal(err)
				}
				defer d2.Close()
				if _, err := d2.Recover(db.RecoverOptions{}); err != nil {
					t.Fatalf("recovery after interrupted undo: %v", err)
				}
				assertZeroPage(t, d2)
			})
		}
	})

	t.Run("undo_interrupted_twice", func(t *testing.T) {
		for flushAfter := 0; flushAfter <= 3; flushAfter++ {
			flushAfter := flushAfter
			t.Run(fmt.Sprintf("flushAfter=%d", flushAfter), func(t *testing.T) {
				dir := t.TempDir()
				setup(t, dir, flushAfter)

				// First recovery: crashes after 1 CLR.
				d1, _ := db.Open(dir)
				if _, err := d1.Recover(db.RecoverOptions{CrashAfterCLRs: 1}); err != db.ErrSimulatedCrash {
					t.Fatalf("want simulated crash, got %v", err)
				}
				d1.Close()
				// Second recovery: crashes after 1 more CLR.
				d2, _ := db.Open(dir)
				if _, err := d2.Recover(db.RecoverOptions{CrashAfterCLRs: 1}); err != db.ErrSimulatedCrash {
					t.Fatalf("want simulated crash, got %v", err)
				}
				d2.Close()
				// Third recovery completes the remaining undo.
				d3, _ := db.Open(dir)
				defer d3.Close()
				rep, err := d3.Recover(db.RecoverOptions{})
				if err != nil {
					t.Fatal(err)
				}
				if rep.CLRsWritten != 1 {
					t.Fatalf("final recovery wrote %d CLRs, want 1 remaining", rep.CLRsWritten)
				}
				assertZeroPage(t, d3)

				// And a fourth run is a pure no-op.
				rep4, err := d3.Recover(db.RecoverOptions{})
				if err != nil {
					t.Fatal(err)
				}
				if rep4.Redone != 0 || rep4.CLRsWritten != 0 {
					t.Fatalf("not idempotent after interrupted undo: %+v", rep4)
				}
			})
		}
	})
}

func assertZeroPage(t *testing.T, d *db.DB) {
	t.Helper()
	got, err := d.ReadPage(pageID)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got[db.PageHeaderLen:], make([]byte, fileadapter.PageSize-db.PageHeaderLen)) {
		t.Fatalf("page not fully rolled back: %.32q...", got[db.PageHeaderLen:])
	}
}

// TestStealNoForce documents the two policies end to end: an uncommitted
// page can reach disk (steal) and a committed page need not (no-force).
func TestStealNoForce(t *testing.T) {
	dir := t.TempDir()
	d, err := db.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t1 := d.Begin()
	t2 := d.Begin()
	if err := d.Write(t1, pageID, 0, []byte("committed")); err != nil {
		t.Fatal(err)
	}
	if err := d.Write(t2, pageID, 64, []byte("uncommitted")); err != nil {
		t.Fatal(err)
	}
	if err := d.FlushPage(pageID); err != nil { // steal: t2's dirty data goes out
		t.Fatal(err)
	}
	if err := d.Commit(t1); err != nil { // no-force: only the log is flushed
		t.Fatal(err)
	}
	d.Close() // crash: buffer pool (with t1's commit) is lost

	d2, err := db.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer d2.Close()
	rep, err := d2.Recover(db.RecoverOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Winners) != 1 || rep.Winners[0] != t1 || len(rep.Losers) != 1 || rep.Losers[0] != t2 {
		t.Fatalf("bad analysis: %+v", rep)
	}
	got, err := d2.ReadPage(pageID)
	if err != nil {
		t.Fatal(err)
	}
	if string(got[db.PageHeaderLen:db.PageHeaderLen+9]) != "committed" {
		t.Fatal("committed write lost")
	}
	if string(got[db.PageHeaderLen+64:db.PageHeaderLen+75]) != string(make([]byte, 11)) {
		t.Fatal("uncommitted write survived recovery")
	}
}
