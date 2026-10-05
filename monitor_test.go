package monitor

import (
	"errors"
	"fmt"
	"math/big"
	"math/rand"
	"path/filepath"
	"testing"
)

func checkSamples(t *testing.T, got, want []Sample) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("sample count: got %d, want %d", len(got), len(want))
	}
	for i := range want {
		g, w := got[i], want[i]
		if g.Time != w.Time || g.Version != w.Version || g.Missing != w.Missing {
			t.Fatalf("sample %d: got %+v, want %+v", i, g, w)
		}
		if !w.Missing && g.Value.Cmp(w.Value) != 0 {
			t.Fatalf("sample %d value: got %s, want %s", i, g.Value, w.Value)
		}
	}
}

func checkIntegral(t *testing.T, st *Store, m *Model, a, b int64) {
	t.Helper()
	got, err := st.Integral(a, b)
	if err != nil {
		t.Fatalf("Integral(%d,%d): %v", a, b, err)
	}
	want := m.Integral(a, b)
	if got.Cmp(want) != 0 {
		t.Fatalf("Integral(%d,%d): got %s, want %s", a, b, got, want)
	}
}

func TestVersionOverwrite(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(filepath.Join(dir, "idx.db"), Options{LeafCapacity: 4, InternalCapacity: 3})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	m := &Model{}

	ops := []Op{
		{Sample: Sample{Time: 5, Value: big.NewRat(1, 2), Version: 1}},
		{Sample: Sample{Time: 5, Value: big.NewRat(3, 2), Version: 2}}, // wins
		{Sample: Sample{Time: 5, Value: big.NewRat(9, 1), Version: 1}}, // stale, dropped
		{Sample: Sample{Time: 5, Value: big.NewRat(7, 1), Version: 2}}, // tie, dropped
		{Sample: Sample{Time: 9, Value: big.NewRat(2, 1), Version: 1}},
	}
	m.Apply(ops...)
	if _, err := st.Commit(ops...); err != nil {
		t.Fatal(err)
	}
	checkSamples(t, st.Samples(), m.Samples())
	if got := st.Samples()[0].Value; got.Cmp(big.NewRat(3, 2)) != 0 {
		t.Fatalf("duplicate timestamp: higher version should win, got %s", got)
	}
	checkIntegral(t, st, m, 0, 20)
	checkIntegral(t, st, m, 5, 9)
}

func TestMissingCutsIntervals(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(filepath.Join(dir, "idx.db"), Options{LeafCapacity: 2, InternalCapacity: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	m := &Model{}

	ops := []Op{
		{Sample: Sample{Time: 0, Value: big.NewRat(0, 1), Version: 1}},
		{Sample: Sample{Time: 10, Missing: true, Version: 1}},
		{Sample: Sample{Time: 20, Value: big.NewRat(2, 1), Version: 1}},
		{Sample: Sample{Time: 30, Value: big.NewRat(4, 1), Version: 1}},
	}
	m.Apply(ops...)
	if _, err := st.Commit(ops...); err != nil {
		t.Fatal(err)
	}

	// Only the 20-30 segment survives; the hole at 10 must not be
	// interpolated across.
	want := big.NewRat(30, 1)
	got, err := st.Integral(0, 30)
	if err != nil {
		t.Fatal(err)
	}
	if got.Cmp(want) != 0 {
		t.Fatalf("integral across hole: got %s, want %s", got, want)
	}
	for _, r := range [][2]int64{{0, 10}, {5, 25}, {10, 20}, {0, 30}, {15, 35}} {
		checkIntegral(t, st, m, r[0], r[1])
	}

	// Filling the hole with a real sample restores the bridge segments.
	fix := []Op{{Sample: Sample{Time: 10, Value: big.NewRat(1, 1), Version: 2}}}
	m.Apply(fix...)
	if _, err := st.Commit(fix...); err != nil {
		t.Fatal(err)
	}
	checkIntegral(t, st, m, 0, 30)
}

func TestRandomOpsMatchModel(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	dir := t.TempDir()
	path := filepath.Join(dir, "idx.db")
	st, err := Open(path, Options{LeafCapacity: 4, InternalCapacity: 3})
	if err != nil {
		t.Fatal(err)
	}
	m := &Model{}

	for batch := 0; batch < 60; batch++ {
		n := 1 + rng.Intn(5)
		ops := make([]Op, 0, n)
		for i := 0; i < n; i++ {
			ts := int64(rng.Intn(60))
			switch rng.Intn(5) {
			case 0:
				ops = append(ops, Op{Delete: true, Sample: Sample{Time: ts}})
			case 1:
				ops = append(ops, Op{Sample: Sample{Time: ts, Missing: true, Version: uint64(rng.Intn(8))}})
			default:
				v := big.NewRat(int64(rng.Intn(41)-20), int64(1+rng.Intn(6)))
				ops = append(ops, Op{Sample: Sample{Time: ts, Value: v, Version: uint64(rng.Intn(8))}})
			}
		}
		m.Apply(ops...)
		if _, err := st.Commit(ops...); err != nil {
			t.Fatalf("batch %d: %v", batch, err)
		}
		for q := 0; q < 4; q++ {
			a := int64(rng.Intn(70)) - 5
			b := a + int64(rng.Intn(30))
			checkIntegral(t, st, m, a, b)
		}
	}
	checkSamples(t, st.Samples(), m.Samples())
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	// Reopen: the recovered index must reproduce the same samples and
	// integrals.
	st2, err := Open(path, Options{LeafCapacity: 4, InternalCapacity: 3})
	if err != nil {
		t.Fatal(err)
	}
	defer st2.Close()
	checkSamples(t, st2.Samples(), m.Samples())
	for q := 0; q < 16; q++ {
		a := int64(rng.Intn(70)) - 5
		b := a + int64(rng.Intn(30))
		checkIntegral(t, st2, m, a, b)
	}
}

func TestBatchPublishAndOldReaders(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(filepath.Join(dir, "idx.db"), Options{LeafCapacity: 4, InternalCapacity: 3})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	mOld := &Model{}
	var base []Op
	for i := 0; i < 24; i++ {
		base = append(base, Op{Sample: Sample{Time: int64(i * 3), Value: big.NewRat(int64(i), 3), Version: 1}})
	}
	mOld.Apply(base...)
	if _, err := st.Commit(base...); err != nil {
		t.Fatal(err)
	}
	snap := st.Snapshot()

	// One batch of corrections, published as a single generation.
	mNew := &Model{}
	mNew.Apply(base...)
	var corr []Op
	for _, i := range []int{2, 7, 13, 20} {
		corr = append(corr, Op{Sample: Sample{Time: int64(i * 3), Value: big.NewRat(int64(100+i), 2), Version: 2}})
	}
	corr = append(corr, Op{Delete: true, Sample: Sample{Time: 30}})
	mNew.Apply(corr...)
	stats, err := st.Commit(corr...)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Generation != snap.Generation()+1 {
		t.Fatalf("batch must publish exactly one generation: snap=%d new=%d", snap.Generation(), stats.Generation)
	}

	// Old reader still sees the pre-correction state.
	for _, r := range [][2]int64{{0, 69}, {6, 40}, {21, 60}} {
		got, err := snap.Integral(r[0], r[1])
		if err != nil {
			t.Fatal(err)
		}
		if want := mOld.Integral(r[0], r[1]); got.Cmp(want) != 0 {
			t.Fatalf("stale snapshot Integral(%d,%d): got %s, want %s", r[0], r[1], got, want)
		}
	}
	snapSamples, err := snap.Samples()
	if err != nil {
		t.Fatal(err)
	}
	checkSamples(t, snapSamples, mOld.Samples())

	// Current view reflects the whole batch at once.
	checkSamples(t, st.Samples(), mNew.Samples())
	for _, r := range [][2]int64{{0, 69}, {6, 40}, {21, 60}} {
		checkIntegral(t, st, mNew, r[0], r[1])
	}
}

func TestIncrementalLocality(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(filepath.Join(dir, "idx.db"), Options{LeafCapacity: 4, InternalCapacity: 4})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	m := &Model{}
	var base []Op
	for i := 0; i < 200; i++ {
		base = append(base, Op{Sample: Sample{Time: int64(i), Value: big.NewRat(int64(i), 3), Version: 1}})
	}
	m.Apply(base...)
	full, err := st.Commit(base...)
	if err != nil {
		t.Fatal(err)
	}
	if full.PagesWritten < 50 {
		t.Fatalf("expected a substantial initial build, wrote %d pages", full.PagesWritten)
	}

	before := m.Integral(-1, 1000)
	corr := Op{Sample: Sample{Time: 100, Value: big.NewRat(7, 2), Version: 2}}
	m.Apply(corr)
	stats, err := st.Commit(corr)
	if err != nil {
		t.Fatal(err)
	}

	// A single correction must only rewrite the pages covering the
	// affected intervals (the leaf, its left neighbour whose trailing
	// segment changed, and their ancestors).
	if stats.PagesWritten == 0 || stats.PagesWritten > 10 {
		t.Fatalf("correction should be local, rewrote %d pages", stats.PagesWritten)
	}

	// The published inverse delta equals the model's integral change.
	after := m.Integral(-1, 1000)
	wantDelta := new(big.Rat).Sub(after, before)
	if stats.Delta.Cmp(wantDelta) != 0 {
		t.Fatalf("inverse delta: got %s, want %s", stats.Delta, wantDelta)
	}
	checkIntegral(t, st, m, 0, 199)
	checkIntegral(t, st, m, 98, 103)
}

// TestCrashRecoveryEnumerateFaults injects a power loss at every write
// point of a commit — each index page, the data sync, and the root
// publication — and verifies that recovery always restores the exact
// pre-commit generation: samples, versions and integrals never mix.
func TestCrashRecoveryEnumerateFaults(t *testing.T) {
	opts := Options{LeafCapacity: 3, InternalCapacity: 3}

	var base []Op
	mBase := &Model{}
	for i := 0; i < 40; i++ {
		base = append(base, Op{Sample: Sample{Time: int64(i * 2), Value: big.NewRat(int64(i), 7), Version: 1}})
	}
	mBase.Apply(base...)

	corr := []Op{
		{Sample: Sample{Time: 10, Value: big.NewRat(55, 2), Version: 2}},
		{Sample: Sample{Time: 40, Value: big.NewRat(-3, 4), Version: 2}},
		{Sample: Sample{Time: 70, Missing: true, Version: 2}},
		{Delete: true, Sample: Sample{Time: 20}},
		{Sample: Sample{Time: 100, Value: big.NewRat(9, 1), Version: 1}},
	}
	mCorr := &Model{}
	mCorr.Apply(base...)
	mCorr.Apply(corr...)

	ranges := [][2]int64{{0, 100}, {8, 44}, {60, 79}, {-5, 3}}

	for k := 1; ; k++ {
		dir := t.TempDir()
		path := filepath.Join(dir, "idx.db")
		st, err := Open(path, opts)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := st.Commit(base...); err != nil {
			t.Fatal(err)
		}
		count := 0
		st.FailHook = func(op string, page uint64) error {
			count++
			if count == k {
				return fmt.Errorf("injected power loss at %s (page %d)", op, page)
			}
			return nil
		}
		_, commitErr := st.Commit(corr...)
		st.Close()

		st2, err := Open(path, opts)
		if err != nil {
			t.Fatalf("fault %d: reopen: %v", k, err)
		}
		if commitErr == nil {
			// k exceeded the number of fault points: the commit went
			// through, so recovery must show the corrected generation.
			checkSamples(t, st2.Samples(), mCorr.Samples())
			for _, r := range ranges {
				checkIntegral(t, st2, mCorr, r[0], r[1])
			}
			st2.Close()
			t.Logf("enumerated %d fault injection points", k-1)
			break
		}
		// The crashed commit must be invisible: exact pre-commit
		// samples (including versions) and integrals.
		checkSamples(t, st2.Samples(), mBase.Samples())
		for _, r := range ranges {
			checkIntegral(t, st2, mBase, r[0], r[1])
		}
		// The recovered store stays usable.
		if _, err := st2.Commit(corr...); err != nil {
			t.Fatalf("fault %d: recommit after recovery: %v", k, err)
		}
		checkSamples(t, st2.Samples(), mCorr.Samples())
		checkIntegral(t, st2, mCorr, 0, 100)
		st2.Close()
	}
}

// TestTornRootPublication simulates a power loss in the middle of the
// root slot write itself; the CRC must reject the half-written slot.
func TestTornRootPublication(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "idx.db")
	opts := Options{LeafCapacity: 3, InternalCapacity: 3}
	st, err := Open(path, opts)
	if err != nil {
		t.Fatal(err)
	}

	mBase := &Model{}
	var base []Op
	for i := 0; i < 20; i++ {
		base = append(base, Op{Sample: Sample{Time: int64(i), Value: big.NewRat(int64(i), 5), Version: 1}})
	}
	mBase.Apply(base...)
	if _, err := st.Commit(base...); err != nil {
		t.Fatal(err)
	}

	st.FailHook = func(op string, page uint64) error {
		if op != "root" {
			return nil
		}
		// Half-written root slot, then power loss.
		torn := encodeSlot(superSlot{gen: st.gen + 1, root: 2, numPages: 99})
		if _, err := st.f.WriteAt(torn[:8], int64(superSlotOff+int((st.gen+1)%2)*superSlotSize)); err != nil {
			return err
		}
		return errors.New("power loss during root publication")
	}
	corr := []Op{{Sample: Sample{Time: 3, Value: big.NewRat(99, 1), Version: 2}}}
	if _, err := st.Commit(corr...); err == nil {
		t.Fatal("expected injected failure")
	}
	st.Close()

	st2, err := Open(path, opts)
	if err != nil {
		t.Fatal(err)
	}
	defer st2.Close()
	checkSamples(t, st2.Samples(), mBase.Samples())
	checkIntegral(t, st2, mBase, 0, 19)
	checkIntegral(t, st2, mBase, 2, 10)
}
