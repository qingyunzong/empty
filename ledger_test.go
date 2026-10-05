package ledger

import (
	"fmt"
	"path/filepath"
	"sync"
	"testing"
)

func mustAppend(t *testing.T, l *Ledger, e Entry) {
	t.Helper()
	if err := l.Append(e); err != nil {
		t.Fatalf("append %+v: %v", e, err)
	}
}

// Empty prefix is defined as 0.
func TestEmptyPrefixIsZero(t *testing.T) {
	l := New()
	for _, axis := range []Axis{BusinessTime, SubmitTime} {
		head := l.Snapshot().EvidenceHead(axis)
		if head.Cumulative != 0 || head.Count != 0 || head.Index != -1 {
			t.Fatalf("%s empty prefix = %+v, want zero", axis, head)
		}
		if _, ok := l.Snapshot().FirstExceeding(axis, 0); ok {
			t.Fatalf("%s: empty ledger must not exceed any budget", axis)
		}
		if got := l.Snapshot().Total(axis); got != 0 {
			t.Fatalf("%s: empty total = %d", axis, got)
		}
	}
}

// Entries sort by (time, ID); equal times fall back to ID order.
func TestOrderingByTimeThenID(t *testing.T) {
	l := New()
	mustAppend(t, l, Entry{ID: 9, Batch: 1, Business: 5, Submit: 5, Fee: 1})
	mustAppend(t, l, Entry{ID: 3, Batch: 1, Business: 5, Submit: 5, Fee: 2})
	mustAppend(t, l, Entry{ID: 7, Batch: 1, Business: 2, Submit: 2, Fee: 4})
	s := l.Snapshot()
	for _, axis := range []Axis{BusinessTime, SubmitTime} {
		ev, ok := s.EvidenceAt(axis, 3)
		if !ok || ev.Index != 1 {
			t.Fatalf("%s: ID 3 should sort before ID 9 at equal time: %+v", axis, ev)
		}
		if cum, _ := s.Cumulative(axis, 7); cum != 4 {
			t.Fatalf("%s: cumulative at earliest entry = %d, want 4", axis, cum)
		}
		if cum, _ := s.Cumulative(axis, 9); cum != 7 {
			t.Fatalf("%s: total = %d, want 7", axis, cum)
		}
	}
}

// Business-time and submission-time accumulation are distinct axes.
func TestDualAxisAccumulation(t *testing.T) {
	l := New()
	// Business order is 1,2,3; submission order is 3,2,1. The big fees sit
	// at opposite ends of the two orderings.
	mustAppend(t, l, Entry{ID: 1, Batch: 1, Business: 1, Submit: 3, Fee: 12})
	mustAppend(t, l, Entry{ID: 2, Batch: 1, Business: 2, Submit: 2, Fee: 1})
	mustAppend(t, l, Entry{ID: 3, Batch: 1, Business: 3, Submit: 1, Fee: 12})
	s := l.Snapshot()
	biz, ok := s.FirstExceeding(BusinessTime, 10)
	if !ok || biz.EntryID != 1 || biz.Cumulative != 12 {
		t.Fatalf("business axis first>10 = %+v, want entry 1 at 12", biz)
	}
	sub, ok := s.FirstExceeding(SubmitTime, 10)
	if !ok || sub.EntryID != 3 || sub.Cumulative != 12 {
		t.Fatalf("submit axis first>10 = %+v, want entry 3 at 12", sub)
	}
	if biz.Index == sub.Index && biz.EntryID == sub.EntryID {
		t.Fatal("axes must disagree on this history")
	}
	if s.Total(BusinessTime) != s.Total(SubmitTime) {
		t.Fatal("totals must agree across axes")
	}
}

// Voiding the entry that pushed the ledger over budget removes the
// out-of-bounds point.
func TestUndoRemovesOutOfBounds(t *testing.T) {
	l := New()
	mustAppend(t, l, Entry{ID: 1, Batch: 1, Business: 1, Submit: 1, Fee: 60})
	mustAppend(t, l, Entry{ID: 2, Batch: 1, Business: 2, Submit: 2, Fee: 50})
	mustAppend(t, l, Entry{ID: 3, Batch: 1, Business: 3, Submit: 3, Fee: 10})
	s := l.Snapshot()
	ev, ok := s.FirstExceeding(BusinessTime, 100)
	if !ok || ev.EntryID != 2 || ev.Cumulative != 110 {
		t.Fatalf("first>100 = %+v ok=%v, want entry 2 at 110", ev, ok)
	}
	if err := l.Void(2); err != nil {
		t.Fatalf("void: %v", err)
	}
	s = l.Snapshot()
	if _, ok := s.FirstExceeding(BusinessTime, 100); ok {
		t.Fatal("out-of-bounds point must disappear after void")
	}
	if got := s.Total(BusinessTime); got != 70 {
		t.Fatalf("total after void = %d, want 70", got)
	}
	if _, ok := s.Cumulative(BusinessTime, 2); ok {
		t.Fatal("voided entry must leave the index")
	}
}

// Negative-fee history: the segment tree must match an item-by-item scan
// for every budget of interest.
func TestNegativeFeesMatchScan(t *testing.T) {
	l := New()
	fees := []int64{40, -15, 70, -90, 25, 10, -5, 60, -30, 20}
	for i, f := range fees {
		mustAppend(t, l, Entry{ID: uint64(i + 1), Batch: 1, Business: int64(i), Submit: int64(i), Fee: f})
	}
	s := l.Snapshot()
	if err := s.Audit(); err != nil {
		t.Fatalf("audit: %v", err)
	}
	for budget := int64(-100); budget <= 100; budget++ {
		got, ok := s.FirstExceeding(BusinessTime, budget)
		want, wantOK, _, _ := s.ScanEvidence(BusinessTime, budget)
		if ok != wantOK || got != want {
			t.Fatalf("budget %d: index %+v/%v, scan %+v/%v", budget, got, ok, want, wantOK)
		}
	}
}

// Locked batches reject in-place voids; reversal appends an offsetting
// batch and leaves every original prefix bit-identical.
func TestLockedBatchReversalKeepsOriginalPrefix(t *testing.T) {
	l := New()
	mustAppend(t, l, Entry{ID: 1, Batch: 1, Business: 1, Submit: 1, Fee: 80})
	mustAppend(t, l, Entry{ID: 2, Batch: 1, Business: 2, Submit: 2, Fee: 50})
	if err := l.LockBatch(1); err != nil {
		t.Fatalf("lock: %v", err)
	}
	before := l.Snapshot()
	evBefore, _ := before.EvidenceAt(BusinessTime, 2)

	if err := l.Void(1); err != ErrBatchLocked {
		t.Fatalf("void on locked batch = %v, want ErrBatchLocked", err)
	}

	// Offset entry 1 with a reversal in a new batch posted later.
	if err := l.Reverse(1, 100, 2, 3, 3); err != nil {
		t.Fatalf("reverse: %v", err)
	}
	s := l.Snapshot()

	evAfter, ok := s.EvidenceAt(BusinessTime, 2)
	if !ok || evAfter != evBefore {
		t.Fatalf("original prefix changed: before %+v after %+v", evBefore, evAfter)
	}
	if got := s.Total(BusinessTime); got != 50 {
		t.Fatalf("total after reversal = %d, want 50", got)
	}
	// The over-budget point at entry 2 (cumulative 130 > 100) survives in
	// history — reversal cannot rewrite it — but the tail drops to 50.
	if ev, ok := s.FirstExceeding(BusinessTime, 100); !ok || ev.EntryID != 2 {
		t.Fatalf("historical breach must remain visible: %+v ok=%v", ev, ok)
	}
	if _, ok := s.FirstExceeding(BusinessTime, 49); !ok {
		t.Fatal("sanity: budget 49 still exceeded at entry 1")
	}
	if err := l.Reverse(1, 101, 3, 4, 4); err != ErrReversalOf {
		t.Fatalf("double reversal = %v, want ErrReversalOf", err)
	}
}

// A reversal backdated on the business axis erases the breach there, while
// the submit axis — where the reversal lands at the tail — keeps the
// historical breach. One undo, two axes, two answers.
func TestReversalEffectDependsOnAxis(t *testing.T) {
	l := New()
	mustAppend(t, l, Entry{ID: 1, Batch: 1, Business: 1, Submit: 1, Fee: 70})
	mustAppend(t, l, Entry{ID: 2, Batch: 1, Business: 3, Submit: 2, Fee: 40})
	if err := l.LockBatch(1); err != nil {
		t.Fatalf("lock: %v", err)
	}
	for _, axis := range []Axis{BusinessTime, SubmitTime} {
		if _, ok := l.Snapshot().FirstExceeding(axis, 100); !ok {
			t.Fatalf("%s: expected breach at 110", axis)
		}
	}
	// Reversal is a new entry: business time 2 (between the originals),
	// submit time 3 (now, after both).
	if err := l.Reverse(2, 200, 2, 2, 3); err != nil {
		t.Fatalf("reverse: %v", err)
	}
	s := l.Snapshot()
	if _, ok := s.FirstExceeding(BusinessTime, 100); ok {
		t.Fatal("business axis: breach must disappear once the reversal lands")
	}
	if ev, ok := s.FirstExceeding(SubmitTime, 100); !ok || ev.EntryID != 2 || ev.Cumulative != 110 {
		t.Fatalf("submit axis: historical breach must remain, got %+v ok=%v", ev, ok)
	}
	if got := s.Total(BusinessTime); got != 70 {
		t.Fatalf("total = %d, want 70", got)
	}
}

// Prefix evidence is a hash chain any replayer can verify.
func TestPrefixEvidenceChain(t *testing.T) {
	l := New()
	entries := []Entry{
		{ID: 1, Batch: 1, Business: 1, Submit: 2, Fee: 5},
		{ID: 2, Batch: 1, Business: 2, Submit: 1, Fee: -3},
		{ID: 3, Batch: 1, Business: 3, Submit: 3, Fee: 8},
	}
	for _, e := range entries {
		mustAppend(t, l, e)
	}
	s := l.Snapshot()
	for _, axis := range []Axis{BusinessTime, SubmitTime} {
		h := offsetBasis
		run := int64(0)
		ordered := make([]Entry, len(entries))
		ai := s.axes[axis]
		for i, id := range ai.ids {
			e, _ := s.Entry(id)
			ordered[i] = e
		}
		for i, e := range ordered {
			run += e.Fee
			h = hashEntry(h, e)
			ev, ok := s.EvidenceAt(axis, e.ID)
			if !ok || ev.Cumulative != run || ev.Hash != h || ev.Count != i+1 {
				t.Fatalf("%s prefix %d: evidence %+v, want cum=%d hash=%d", axis, i, ev, run, h)
			}
		}
	}
}

// Concurrent readers only ever observe consistent, fully audited snapshots.
func TestAtomicPublication(t *testing.T) {
	l := New()
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for r := 0; r < 4; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			lastSeq := uint64(0)
			for {
				select {
				case <-stop:
					return
				default:
				}
				s := l.Snapshot()
				if s.Seq() < lastSeq {
					t.Error("snapshot sequence went backwards")
					return
				}
				lastSeq = s.Seq()
				if err := s.Audit(); err != nil {
					t.Errorf("inconsistent snapshot: %v", err)
					return
				}
			}
		}()
	}
	for i := 0; i < 200; i++ {
		e := Entry{ID: uint64(i + 1), Batch: uint64(i/10 + 1), Business: int64(i), Submit: int64(i), Fee: int64(i%7) - 3}
		if err := l.Append(e); err != nil {
			t.Fatalf("append: %v", err)
		}
		if i%25 == 24 {
			if err := l.Void(uint64(i - 12)); err != nil {
				t.Fatalf("void: %v", err)
			}
		}
	}
	close(stop)
	wg.Wait()
	if err := l.Snapshot().Audit(); err != nil {
		t.Fatalf("final audit: %v", err)
	}
}

// Recovery: a reopened ledger replays the log and recomputes both axes;
// evidence must match the pre-crash snapshot exactly.
func TestCrashRecoveryMatchesRecompute(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	l, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	fees := []int64{15, -8, 42, 60, -20, 5}
	for i, f := range fees {
		mustAppend(t, l, Entry{ID: uint64(i + 1), Batch: 1, Business: int64(i), Submit: int64(i), Fee: f})
	}
	if err := l.LockBatch(1); err != nil {
		t.Fatalf("lock: %v", err)
	}
	if err := l.Reverse(4, 100, 2, 6, 6); err != nil {
		t.Fatalf("reverse: %v", err)
	}
	want := l.Snapshot()
	if err := l.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	re, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer re.Close()
	got := re.Snapshot()
	if got.Len() != want.Len() || got.Seq() != want.Seq() {
		t.Fatalf("recovered len/seq = %d/%d, want %d/%d", got.Len(), got.Seq(), want.Len(), want.Seq())
	}
	for _, axis := range []Axis{BusinessTime, SubmitTime} {
		for id := uint64(1); id <= 6; id++ {
			we, _ := want.EvidenceAt(axis, id)
			ge, ok := got.EvidenceAt(axis, id)
			if !ok || ge != we {
				t.Fatalf("%s entry %d: recovered %+v, want %+v", axis, id, ge, we)
			}
		}
		rev, _ := got.EvidenceAt(axis, 100)
		wrev, _ := want.EvidenceAt(axis, 100)
		if rev != wrev {
			t.Fatalf("%s reversal evidence: %+v vs %+v", axis, rev, wrev)
		}
		for _, budget := range []int64{0, 30, 60, 90} {
			ge, gok := got.FirstExceeding(axis, budget)
			we, wok := want.FirstExceeding(axis, budget)
			if gok != wok || ge != we {
				t.Fatalf("%s budget %d: recovered %+v/%v, want %+v/%v", axis, budget, ge, gok, we, wok)
			}
		}
	}
	if err := got.Audit(); err != nil {
		t.Fatalf("post-recovery audit: %v", err)
	}
	// The recovered ledger stays writable.
	mustAppend(t, re, Entry{ID: 200, Batch: 3, Business: 7, Submit: 7, Fee: 1})
	if got := re.Snapshot().Total(BusinessTime); got != want.Total(BusinessTime)+1 {
		t.Fatal("recovered ledger rejected new writes")
	}
}

// Replay rejects a void of a locked batch, proving the lock op persisted.
func TestRecoveryRejectsLockedVoid(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.wal")
	l, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	mustAppend(t, l, Entry{ID: 1, Batch: 7, Business: 1, Submit: 1, Fee: 9})
	if err := l.LockBatch(7); err != nil {
		t.Fatalf("lock: %v", err)
	}
	l.Close()
	re, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer re.Close()
	if err := re.Void(1); err != ErrBatchLocked {
		t.Fatalf("void after recovery = %v, want ErrBatchLocked", err)
	}
}

func ExampleSnapshot_FirstExceeding() {
	l := New()
	l.Append(Entry{ID: 1, Batch: 1, Business: 1, Submit: 1, Fee: 40})
	l.Append(Entry{ID: 2, Batch: 1, Business: 2, Submit: 2, Fee: -10})
	l.Append(Entry{ID: 3, Batch: 1, Business: 3, Submit: 3, Fee: 45})
	ev, ok := l.Snapshot().FirstExceeding(BusinessTime, 50)
	fmt.Println(ok, ev.EntryID, ev.Cumulative)
	// Output: true 3 75
}
