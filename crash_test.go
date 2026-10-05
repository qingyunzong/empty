package sigdb

import (
	"errors"
	"io"
	"testing"
)

// memFile is a plain in-memory rawFile: every write is immediately durable.
type memFile struct{ buf []byte }

func newMemFile() *memFile { return &memFile{} }

func (f *memFile) ReadAt(p []byte, off int64) (int, error) {
	if off >= int64(len(f.buf)) {
		return 0, io.EOF
	}
	n := copy(p, f.buf[off:])
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

func (f *memFile) WriteAt(p []byte, off int64) (int, error) {
	end := off + int64(len(p))
	if end > int64(len(f.buf)) {
		nb := make([]byte, end)
		copy(nb, f.buf)
		f.buf = nb
	}
	copy(f.buf[off:], p)
	return len(p), nil
}

func (f *memFile) Sync() error          { return nil }
func (f *memFile) Size() (int64, error) { return int64(len(f.buf)), nil }
func (f *memFile) Close() error         { return nil }
func (f *memFile) Truncate(size int64) error {
	f.buf = f.buf[:size]
	return nil
}

var errPowerLoss = errors.New("simulated power loss")

// faultCtl models the power supply of one machine: all devices lose their
// un-synced buffers together when it trips.
type faultCtl struct {
	devices []*crashFile
	ops     int        // side-effecting ops executed since arming
	failAt  int        // op index at which power fails; -1 = never
	torn    bool       // the failing write lands only half of its bytes
	only    *crashFile // if set, only ops on this device count/arm
	crashed bool
}

// arm starts counting side-effecting ops from zero; the power fails when the
// count reaches failAt. If only is non-nil, only that device's ops count.
func (c *faultCtl) arm(failAt int, torn bool, only *crashFile) {
	c.ops = 0
	c.failAt = failAt
	c.torn = torn
	c.only = only
}

// crashFile is a rawFile with a volatile buffer and a durable platter.
// WriteAt stages into the volatile buffer; Sync makes it durable; a power
// loss reverts the volatile buffer to the durable state.
type crashFile struct {
	ctl *faultCtl
	vol []byte
	dur []byte
}

func newCrashMachine() (*faultCtl, *crashFile, *crashFile) {
	ctl := &faultCtl{failAt: -1}
	d := &crashFile{ctl: ctl}
	c := &crashFile{ctl: ctl}
	ctl.devices = []*crashFile{d, c}
	return ctl, d, c
}

// reboot models a power cycle: new devices see only what was durable.
func reboot(ctl *faultCtl) (*faultCtl, *crashFile, *crashFile) {
	nctl := &faultCtl{failAt: -1}
	var files []*crashFile
	for _, old := range ctl.devices {
		f := &crashFile{ctl: nctl}
		f.dur = append([]byte(nil), old.dur...)
		f.vol = append([]byte(nil), old.dur...)
		files = append(files, f)
	}
	nctl.devices = []*crashFile{files[0], files[1]}
	return nctl, files[0], files[1]
}

func (c *faultCtl) trip() {
	for _, d := range c.devices {
		d.vol = append([]byte(nil), d.dur...)
	}
	c.crashed = true
}

// gate returns errPowerLoss when the failing op is reached. It must be
// called before every side-effecting op; the op counter only advances when
// the op is allowed to happen.
func (c *faultCtl) gate(f *crashFile) error {
	if c.crashed {
		return errPowerLoss
	}
	if c.only != nil && c.only != f {
		return nil
	}
	if c.failAt >= 0 && c.ops == c.failAt {
		c.trip()
		return errPowerLoss
	}
	c.ops++
	return nil
}

func (f *crashFile) writeVol(p []byte, off int64) {
	end := off + int64(len(p))
	if end > int64(len(f.vol)) {
		nb := make([]byte, end)
		copy(nb, f.vol)
		f.vol = nb
	}
	copy(f.vol[off:], p)
}

func (f *crashFile) WriteAt(p []byte, off int64) (int, error) {
	if err := f.ctl.gate(f); err != nil {
		if f.ctl.torn && len(p) > 1 {
			// A torn sector write: only part of the payload lands.
			f.writeVol(p[:len(p)/2], off)
			f.ctl.torn = false
		}
		return 0, err
	}
	f.writeVol(p, off)
	return len(p), nil
}

func (f *crashFile) Sync() error {
	if err := f.ctl.gate(f); err != nil {
		return err
	}
	f.dur = append([]byte(nil), f.vol...)
	return nil
}

func (f *crashFile) Truncate(size int64) error {
	if err := f.ctl.gate(f); err != nil {
		return err
	}
	f.vol = f.vol[:size]
	return nil
}

func (f *crashFile) ReadAt(p []byte, off int64) (int, error) {
	if off >= int64(len(f.vol)) {
		return 0, io.EOF
	}
	n := copy(p, f.vol[off:])
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

func (f *crashFile) Size() (int64, error) { return int64(len(f.vol)), nil }
func (f *crashFile) Close() error         { return nil }

// crashScenario builds a store, commits batch1, then commits batch2 while
// the power fails at side-effecting op failAt of batch2's commit (failAt < 0
// means no failure). It returns the store recovered after a reboot plus the
// reference models before and after batch2.
func crashScenario(t *testing.T, failAt int, torn bool) (*Store, *refModel, *refModel, uint64) {
	t.Helper()
	ctl, data, commit := newCrashMachine()
	s, err := openStore(data, commit)
	if err != nil {
		t.Fatal(err)
	}
	batch1 := []Op{
		toPut(0, 1, rat("2")), toPut(10, 1, rat("4")), toPut(20, 1, rat("6")),
		toPut(30, 1, rat("8")), toPut(40, 1, rat("10")),
	}
	if _, _, err := s.Apply(batch1); err != nil {
		t.Fatal(err)
	}
	mBefore := newRefModel()
	mBefore.apply(batch1)
	genBefore := s.Head().Generation()

	// Arm the power supply, then run batch2's commit.
	ctl.arm(failAt, torn, nil)
	batch2 := []Op{
		toPut(10, 2, rat("14")), toPut(15, 1, rat("5")), Missing(30, 2),
		Delete(40, 2), toPut(50, 1, rat("12")), toPut(5, 1, rat("3")),
	}
	if _, _, err := s.Apply(batch2); err != nil && failAt < 0 {
		t.Fatalf("unexpected apply error: %v", err)
	}
	mAfter := mBefore.clone()
	mAfter.apply(batch2)

	// Power cycle and recover.
	_, data2, commit2 := reboot(ctl)
	rec, err := openStore(data2, commit2)
	if err != nil {
		t.Fatalf("recovery failed: %v", err)
	}
	return rec, mBefore, mAfter, genBefore
}

func checkConsistent(t *testing.T, s *Store, m *refModel, context string) {
	t.Helper()
	checkSamples(t, s.Head(), m)
	for _, q := range [][2]int64{{-10, 100}, {0, 50}, {3, 37}, {12, 12}, {45, 200}, {0, 9}, {11, 14}} {
		if got, want := s.Head().Integral(q[0], q[1]), m.integral(q[0], q[1]); got.Cmp(want) != 0 {
			t.Fatalf("%s: Integral(%d,%d) = %s, want %s", context, q[0], q[1], got, want)
		}
	}
}

// TestCrashEnumeration enumerates every possible power-failure point of a
// commit — every index page write, the data fsync, the root publish write
// and its fsync — in both clean and torn-write variants, and verifies that
// recovery always lands on exactly one consistent generation: samples and
// integrals are never mixed across versions.
func TestCrashEnumeration(t *testing.T) {
	// Dry run to count the side-effecting ops of batch2's commit.
	probe, _, _, genBefore := crashScenario(t, -1, false)
	_ = probe
	// Count ops with a fresh instrumented run.
	ctl, data, commit := newCrashMachine()
	s, err := openStore(data, commit)
	if err != nil {
		t.Fatal(err)
	}
	batch1 := []Op{
		toPut(0, 1, rat("2")), toPut(10, 1, rat("4")), toPut(20, 1, rat("6")),
		toPut(30, 1, rat("8")), toPut(40, 1, rat("10")),
	}
	if _, _, err := s.Apply(batch1); err != nil {
		t.Fatal(err)
	}
	ctl.arm(-1, false, nil)
	batch2 := []Op{
		toPut(10, 2, rat("14")), toPut(15, 1, rat("5")), Missing(30, 2),
		Delete(40, 2), toPut(50, 1, rat("12")), toPut(5, 1, rat("3")),
	}
	if _, _, err := s.Apply(batch2); err != nil {
		t.Fatal(err)
	}
	totalOps := ctl.ops
	if totalOps < 4 {
		t.Fatalf("commit should take several ops, got %d", totalOps)
	}
	t.Logf("commit of batch2 executes %d side-effecting ops", totalOps)

	sawOld, sawNew := false, false
	for failAt := 0; failAt <= totalOps; failAt++ {
		for _, torn := range []bool{false, true} {
			rec, mBefore, mAfter, gb := crashScenario(t, failAt, torn)
			if gb != genBefore {
				t.Fatalf("genBefore mismatch: %d vs %d", gb, genBefore)
			}
			gen := rec.Head().Generation()
			switch gen {
			case genBefore:
				sawOld = true
				checkConsistent(t, rec, mBefore, "old generation")
			case genBefore + 1:
				sawNew = true
				checkConsistent(t, rec, mAfter, "new generation")
			default:
				t.Fatalf("failAt=%d torn=%v: recovered generation %d mixes samples and index versions", failAt, torn, gen)
			}
		}
	}
	if !sawOld || !sawNew {
		t.Fatalf("enumeration did not exercise both outcomes: old=%v new=%v", sawOld, sawNew)
	}
}

// TestRootPublishFailure focuses on the root publish step itself: a crash
// (clean or torn) on any commit-file op must leave the previous generation
// fully intact, because the commit record is the single atomic publish
// point for samples and index together.
func TestRootPublishFailure(t *testing.T) {
	batch1 := []Op{
		toPut(0, 1, rat("2")), toPut(10, 1, rat("4")), toPut(20, 1, rat("6")),
		toPut(30, 1, rat("8")), toPut(40, 1, rat("10")),
	}
	batch2 := []Op{
		toPut(10, 2, rat("14")), toPut(15, 1, rat("5")), Missing(30, 2),
		Delete(40, 2), toPut(50, 1, rat("12")), toPut(5, 1, rat("3")),
	}
	mBefore := newRefModel()
	mBefore.apply(batch1)
	mAfter := mBefore.clone()
	mAfter.apply(batch2)

	run := func(failAt int, torn bool) (*Store, uint64) {
		ctl, data, commit := newCrashMachine()
		s, err := openStore(data, commit)
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := s.Apply(batch1); err != nil {
			t.Fatal(err)
		}
		genBefore := s.Head().Generation()
		ctl.arm(failAt, torn, commit) // fail only on the commit (root) device
		if _, _, err := s.Apply(batch2); err != nil && failAt < 0 {
			t.Fatalf("unexpected apply error: %v", err)
		}
		_, data2, commit2 := reboot(ctl)
		rec, err := openStore(data2, commit2)
		if err != nil {
			t.Fatalf("recovery failed: %v", err)
		}
		return rec, genBefore
	}

	// Count commit-file ops of a clean commit: the root write plus its sync.
	probe, genBefore := run(-1, false)
	if probe.Head().Generation() != genBefore+1 {
		t.Fatalf("clean run must advance the generation")
	}
	// Re-count precisely with a fresh instrumented run.
	ctl, data, commit := newCrashMachine()
	s, err := openStore(data, commit)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Apply(batch1); err != nil {
		t.Fatal(err)
	}
	ctl.arm(-1, false, commit)
	if _, _, err := s.Apply(batch2); err != nil {
		t.Fatal(err)
	}
	commitOps := ctl.ops
	if commitOps < 2 {
		t.Fatalf("expected commit write+sync on commit file, got %d ops", commitOps)
	}
	t.Logf("root publish executes %d commit-file ops", commitOps)

	for failAt := 0; failAt < commitOps; failAt++ {
		for _, torn := range []bool{false, true} {
			rec, gb := run(failAt, torn)
			if gen := rec.Head().Generation(); gen != gb {
				t.Fatalf("failAt=%d torn=%v: root publish failure leaked generation %d", failAt, torn, gen)
			}
			checkConsistent(t, rec, mBefore, "root publish failure")
		}
	}
	// And a crash just after the publish must expose the full new generation.
	rec, gb := run(commitOps, false)
	if gen := rec.Head().Generation(); gen != gb+1 {
		t.Fatalf("completed publish must be visible, got gen %d want %d", gen, gb+1)
	}
	checkConsistent(t, rec, mAfter, "completed publish")
}

// TestRecoveredIndexMatchesSamples verifies after recovery that the integral
// index agrees with the recovered sample versions for every range — i.e. a
// power failure can never leave new integrals indexed against old samples.
func TestRecoveredIndexMatchesSamples(t *testing.T) {
	for failAt := 0; failAt <= 12; failAt++ {
		rec, _, _, _ := crashScenario(t, failAt, failAt%2 == 0)
		// Rebuild the model purely from the recovered samples and compare.
		m := newRefModel()
		for _, smp := range rec.Head().Samples() {
			m.entries[smp.T] = entry{t: smp.T, version: smp.Version, kind: smp.Kind, v: smp.V}
		}
		for a := int64(-5); a < 60; a += 7 {
			for b := a; b < 60; b += 11 {
				if got, want := rec.Head().Integral(a, b), m.integral(a, b); got.Cmp(want) != 0 {
					t.Fatalf("failAt=%d: index/sample mix detected at [%d,%d]: got %s want %s",
						failAt, a, b, got, want)
				}
			}
		}
	}
}
