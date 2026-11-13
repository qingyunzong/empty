package dataeng

import (
	"errors"
	"math"
	"testing"
)

// scan drives a Snapshot with a fake keyset table. It advances through holes
// exactly as a real collector should: commit the whole interval, not a row
// count.
func scan(t *testing.T, s Snapshot, limit int, rows []Key, commit func(Chunk, []Key)) []Key {
	t.Helper()
	var got []Key
	sc := NewScanner(s)
	for {
		chunk, more, err := sc.Next(limit)
		if err != nil {
			t.Fatalf("Next: %v", err)
		}
		if !more {
			break
		}
		var inRange []Key
		for _, k := range rows {
			lowerOK := k >= chunk.From
			if chunk.After.Set {
				lowerOK = k > chunk.After.Key
			}
			if lowerOK && k <= chunk.Through {
				inRange = append(inRange, k)
			}
		}
		got = append(got, inRange...)
		if commit != nil {
			commit(chunk, inRange)
		}
		if err := sc.CommitThrough(); err != nil {
			t.Fatalf("CommitThrough: %v", err)
		}
	}
	if !sc.Done() {
		t.Fatal("scanner did not reach its ceiling")
	}
	return got
}

func TestSnapshotFixesACeiling(t *testing.T) {
	rows := []Key{1, 2, 3, 4, 5, 11, 12}
	s, err := BeginSnapshot(5, WithStartKey(1))
	if err != nil {
		t.Fatalf("BeginSnapshot: %v", err)
	}

	var chunks []Chunk
	got := scan(t, s, 2, rows, func(c Chunk, _ []Key) {
		chunks = append(chunks, c)
	})

	want := []Key{1, 2, 3, 4, 5}
	if len(got) != len(want) {
		t.Fatalf("got keys %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got keys %v, want %v", got, want)
		}
	}
	for _, c := range chunks {
		if c.Through > 5 {
			t.Fatalf("chunk crossed the fixed ceiling: %+v", c)
		}
		if c.Generation != s.Generation() {
			t.Fatalf("chunk generation = %d, want %d", c.Generation, s.Generation())
		}
	}
}

func TestNewRowsWaitForNextGeneration(t *testing.T) {
	rows := []Key{1, 2, 10, 11, 12}
	s, err := BeginSnapshot(10, WithStartKey(1))
	if err != nil {
		t.Fatalf("BeginSnapshot: %v", err)
	}
	got := scan(t, s, 100, rows, nil)
	if len(got) != 3 {
		t.Fatalf("initial snapshot = %v, want only keys through 10", got)
	}

	next, err := s.NextGeneration(12, "")
	if err != nil {
		t.Fatalf("NextGeneration: %v", err)
	}
	if next.Generation() != s.Generation()+1 {
		t.Fatalf("generation = %d, want %d", next.Generation(), s.Generation()+1)
	}
	if next.Lower() != After(10) {
		t.Fatalf("lower = %+v, want exclusive 10", next.Lower())
	}
	got = scan(t, next, 100, rows, nil)
	want := []Key{11, 12}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("incremental generation = %v, want %v", got, want)
	}
}

func TestDeletionHolesDoNotStallProgress(t *testing.T) {
	rows := []Key{1, 2, 10}
	s, err := BeginSnapshot(10, WithStartKey(1))
	if err != nil {
		t.Fatalf("BeginSnapshot: %v", err)
	}

	var empty int
	got := scan(t, s, 3, rows, func(c Chunk, rows []Key) {
		if len(rows) == 0 {
			empty++
		}
	})
	if len(got) != 3 || got[0] != 1 || got[1] != 2 || got[2] != 10 {
		t.Fatalf("got keys %v", got)
	}
	if empty != 2 {
		t.Fatalf("empty-hole chunks = %d, want 2", empty)
	}
}

func TestCommittingAnEmptyIntervalAdvances(t *testing.T) {
	s, err := BeginSnapshot(7, WithStartKey(1))
	if err != nil {
		t.Fatalf("BeginSnapshot: %v", err)
	}
	sc := NewScanner(s)
	chunk, more, err := sc.Next(100)
	if err != nil || !more {
		t.Fatalf("Next = %+v, %v, %v", chunk, more, err)
	}
	if err := sc.CommitThrough(); err != nil {
		t.Fatalf("CommitThrough: %v", err)
	}
	if !sc.Done() {
		t.Fatalf("scanner should be done after committing the whole range, cursor=%+v", sc.Cursor())
	}
}

func TestAdvanceToKeepsRemainderReachable(t *testing.T) {
	s, err := BeginSnapshot(10, WithStartKey(1))
	if err != nil {
		t.Fatalf("BeginSnapshot: %v", err)
	}
	sc := NewScanner(s)
	chunk, more, err := sc.Next(5)
	if err != nil || !more {
		t.Fatalf("Next = %+v, %v, %v", chunk, more, err)
	}
	if err := sc.AdvanceTo(3); err != nil {
		t.Fatalf("AdvanceTo: %v", err)
	}
	chunk, more, err = sc.Next(5)
	if err != nil || !more {
		t.Fatalf("Next after partial read = %+v, %v, %v", chunk, more, err)
	}
	if chunk.After != After(3) || chunk.Through != 8 {
		t.Fatalf("second chunk = %+v, want (3,8]", chunk)
	}
	if err := sc.AdvanceTo(6); err != nil {
		t.Fatalf("AdvanceTo: %v", err)
	}
}

func TestScannerResumesAtAnExclusiveCursor(t *testing.T) {
	s, err := BeginSnapshot(10, WithStartKey(1))
	if err != nil {
		t.Fatalf("BeginSnapshot: %v", err)
	}
	sc, err := NewScannerAt(s, After(7))
	if err != nil {
		t.Fatalf("NewScannerAt: %v", err)
	}
	chunk, more, err := sc.Next(2)
	if err != nil || !more {
		t.Fatalf("Next = %+v, %v, %v", chunk, more, err)
	}
	if chunk.After != After(7) || chunk.Through != 9 {
		t.Fatalf("resumed chunk = %+v, want (7,9]", chunk)
	}
	if _, err := NewScannerAt(s, After(11)); !errors.Is(err, ErrCursorAfterCeiling) {
		t.Fatalf("cursor after ceiling error = %v", err)
	}
	if _, err := NewScannerAt(s, After(0)); !errors.Is(err, ErrCursorBeforeStart) {
		t.Fatalf("cursor before start error = %v", err)
	}
}

func TestChunkPlannerDoesNotOverflowAtMaxInt64(t *testing.T) {
	s, err := BeginSnapshot(math.MaxInt64, WithStartKey(math.MaxInt64-2))
	if err != nil {
		t.Fatalf("BeginSnapshot: %v", err)
	}
	sc := NewScanner(s)
	chunk, more, err := sc.Next(100)
	if err != nil || !more {
		t.Fatalf("Next = %+v, %v, %v", chunk, more, err)
	}
	if chunk.Through != math.MaxInt64 {
		t.Fatalf("through = %d, want MaxInt64", chunk.Through)
	}
	if err := sc.CommitThrough(); err != nil {
		t.Fatalf("CommitThrough: %v", err)
	}
	if !sc.Done() {
		t.Fatal("scanner should be done at MaxInt64")
	}
}

func TestInvalidInputs(t *testing.T) {
	if _, err := BeginSnapshot(-1); !errors.Is(err, ErrInvalidCeiling) {
		t.Fatalf("negative ceiling error = %v", err)
	}
	if _, err := BeginSnapshot(1, WithStartKey(2)); !errors.Is(err, ErrInvalidStart) {
		t.Fatalf("start > ceiling error = %v", err)
	}
	s, err := BeginSnapshot(10)
	if err != nil {
		t.Fatalf("BeginSnapshot: %v", err)
	}
	if _, _, err := s.Next(Cursor{}, 0); !errors.Is(err, ErrInvalidLimit) {
		t.Fatalf("zero limit error = %v", err)
	}
	if _, _, err := s.Next(After(-1), 10); !errors.Is(err, ErrCursorBeforeStart) {
		t.Fatalf("cursor before start error = %v", err)
	}
	sc := NewScanner(s)
	if err := sc.CommitThrough(); !errors.Is(err, ErrNoPendingChunk) {
		t.Fatalf("commit without chunk error = %v", err)
	}
}

func TestMaxRegressionRequiresChangeLog(t *testing.T) {
	s, err := BeginSnapshot(100, WithStartKey(1))
	if err != nil {
		t.Fatalf("BeginSnapshot: %v", err)
	}
	if _, err := s.NextGeneration(80, ""); !errors.Is(err, ErrMaxRegressed) {
		t.Fatalf("max regression error = %v, want ErrMaxRegressed", err)
	}

	next, err := s.NextGeneration(80, ChangeLogPosition("binlog.000001:4"))
	if err != nil {
		t.Fatalf("NextGeneration with change log: %v", err)
	}
	if next.Ceiling() != 100 {
		t.Fatalf("ceiling moved backwards: %d", next.Ceiling())
	}
	if !next.HasChangeLog() {
		t.Fatal("change log position was not retained")
	}
	if _, more, err := next.Next(next.Lower(), 10); err != nil || more {
		t.Fatalf("regressed generation key range = more %v, err %v", more, err)
	}
}

func TestMaxWatchNeverClaimsMaxIsEnough(t *testing.T) {
	w, err := NewMaxWatch(10)
	if err != nil {
		t.Fatalf("NewMaxWatch: %v", err)
	}
	for _, current := range []Key{10, 10, 20, 15} {
		obs, err := w.Observe(current)
		if err != nil {
			t.Fatalf("Observe(%d): %v", current, err)
		}
		if !obs.ChangeLogRequired {
			t.Fatalf("Observe(%d) claimed MAX is authoritative", current)
		}
		if !obs.LowKeyPossible {
			t.Fatalf("Observe(%d) claimed low-key inserts are impossible", current)
		}
		if current == 15 && (!obs.BelowHigh || !obs.PossibleWrapOrReuse || obs.Status != MaxRegressed) {
			t.Fatalf("regression observation = %+v", obs)
		}
	}
	if w.High() != 20 {
		t.Fatalf("high = %d, want 20", w.High())
	}
}

func TestKeyGuardFlagsLowAndRegressingKeys(t *testing.T) {
	s, err := BeginSnapshot(10, WithStartKey(1))
	if err != nil {
		t.Fatalf("BeginSnapshot: %v", err)
	}
	g := NewKeyGuard(s)
	if got := g.Observe(3); got != KeyCurrent {
		t.Fatalf("Observe(3) = %v", got)
	}
	if got := g.Observe(2); got != KeyOutOfOrder {
		t.Fatalf("Observe(2) = %v, want out-of-order", got)
	}
	if got := g.Observe(11); got != KeyNextGeneration {
		t.Fatalf("Observe(11) = %v, want next generation", got)
	}
	if got := g.Observe(0); got != KeyLow {
		t.Fatalf("Observe(0) = %v, want low", got)
	}
	if !g.NeedsCompensation() {
		t.Fatal("guard did not request compensation")
	}

	next, err := s.NextGeneration(20, "lsn:9")
	if err != nil {
		t.Fatalf("NextGeneration: %v", err)
	}
	g = NewKeyGuard(next)
	if got := g.Observe(5); got != KeyLow {
		t.Fatalf("Observe(5) below incremental floor = %v, want low", got)
	}
	if !g.NeedsCompensation() {
		t.Fatal("incremental guard did not request change-log compensation")
	}
}
