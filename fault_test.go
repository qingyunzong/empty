package dedup

import (
	"errors"
	"fmt"
	"io"
	"math/rand"
	"testing"
)

// errCrash is injected at a write boundary to simulate power loss.
var errCrash = errors.New("injected power loss")

// faultFile models storage across power loss: writes land in a volatile
// image and only Sync makes them durable. A crash discards everything not
// synced. Every WriteAt/Truncate/Sync is a fault-injection boundary.
type faultFile struct {
	durable []byte
	pending []byte
	failAt  int // boundary index at which to crash; -1 disables injection
	count   int // boundaries crossed so far
	crashed bool
	torn    bool // on crash, keep a random partial write in pending
	rnd     *rand.Rand
}

func newFaultFile() *faultFile { return &faultFile{failAt: -1} }

func (f *faultFile) boundary() error {
	if f.crashed {
		return errCrash
	}
	if f.failAt >= 0 && f.count >= f.failAt {
		f.crashed = true
		return errCrash
	}
	f.count++
	return nil
}

func (f *faultFile) ReadAt(p []byte, off int64) (int, error) {
	if off >= int64(len(f.pending)) {
		return 0, io.EOF
	}
	n := copy(p, f.pending[off:])
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

func (f *faultFile) WriteAt(p []byte, off int64) (int, error) {
	if err := f.boundary(); err != nil {
		if f.torn && len(p) > 1 {
			// Power died mid-write: a random prefix reached the disk.
			f.writeBytes(p[:f.rnd.Intn(len(p))], off)
		}
		return 0, err
	}
	f.writeBytes(p, off)
	return len(p), nil
}

func (f *faultFile) writeBytes(p []byte, off int64) {
	end := int(off) + len(p)
	if end > len(f.pending) {
		grown := make([]byte, end)
		copy(grown, f.pending)
		f.pending = grown
	}
	copy(f.pending[off:], p)
}

func (f *faultFile) Truncate(size int64) error {
	if err := f.boundary(); err != nil {
		return err
	}
	f.pending = f.pending[:size]
	return nil
}

func (f *faultFile) Sync() error {
	if err := f.boundary(); err != nil {
		return err
	}
	f.durable = append(f.durable[:0], f.pending...)
	return nil
}

func (f *faultFile) Close() error { return nil }

// snapshot returns the storage as it looks after the crash: only synced
// bytes survive. The returned file never injects faults again.
func (f *faultFile) snapshot() *faultFile {
	durable := append([]byte(nil), f.durable...)
	return &faultFile{
		durable: durable,
		pending: append([]byte(nil), durable...),
		failAt:  -1,
	}
}

// refModel is the reference implementation: it keeps the COMPLETE set of
// sequence numbers per producer and derives windowed decisions from it.
type refModel struct {
	window int
	seen   map[string]map[uint64]struct{}
	max    map[string]uint64
	data   map[string]string
}

func newRefModel(window int) *refModel {
	return &refModel{
		window: window,
		seen:   make(map[string]map[uint64]struct{}),
		max:    make(map[string]uint64),
		data:   make(map[string]string),
	}
}

func (r *refModel) apply(producer string, seq uint64, ops []Op) Decision {
	seen, ok := r.seen[producer]
	if ok {
		if max := r.max[producer]; seq <= max && max-seq >= uint64(r.window) {
			return TooOld
		}
		if _, dup := seen[seq]; dup {
			return Duplicate
		}
	} else {
		seen = make(map[uint64]struct{})
		r.seen[producer] = seen
	}
	seen[seq] = struct{}{}
	if !ok || seq > r.max[producer] {
		r.max[producer] = seq
	}
	for _, op := range ops {
		r.data[op.Key] = op.Value
	}
	return New
}

type cmd struct {
	producer string
	seq      uint64
	ops      []Op
}

func fxOp(p string, seq uint64) Op {
	return Put(fmt.Sprintf("fx/%s/%d", p, seq), "1")
}

// drive runs the script against a DB built on ff, reopening from the
// durable snapshot whenever a crash is injected, and checks every decision
// and effect against the complete-sequence-set reference model.
func drive(t *testing.T, ff *faultFile, window int, script []cmd) {
	t.Helper()
	ref := newRefModel(window)
	wasNew := make(map[string]map[uint64]bool)

	db, err := OpenWithFile(ff, window)
	if err != nil {
		t.Fatal(err)
	}
	for i, c := range script {
		var dec Decision
		for {
			dec, err = db.Apply(c.producer, c.seq, c.ops...)
			if errors.Is(err, errCrash) {
				db.Close()
				ff = ff.snapshot()
				db, err = OpenWithFile(ff, window)
				if err != nil {
					t.Fatal(err)
				}
				continue
			}
			if err != nil {
				t.Fatalf("cmd %d: unexpected error: %v", i, err)
			}
			break
		}
		want := ref.apply(c.producer, c.seq, c.ops)
		if dec != want {
			t.Fatalf("cmd %d (%s,%d): decision %v, reference says %v",
				i, c.producer, c.seq, dec, want)
		}
		if dec == New {
			// The effect of this message must never have been applied before.
			if wasNew[c.producer][c.seq] {
				t.Fatalf("cmd %d (%s,%d): effect applied twice", i, c.producer, c.seq)
			}
			if wasNew[c.producer] == nil {
				wasNew[c.producer] = make(map[uint64]bool)
			}
			wasNew[c.producer][c.seq] = true
		}
	}
	db.Close()

	// Final state, recovered from durable storage alone, must equal the
	// reference model built from the complete sequence set.
	final, err := OpenWithFile(ff.snapshot(), window)
	if err != nil {
		t.Fatal(err)
	}
	defer final.Close()
	for k, want := range ref.data {
		if got, ok := final.Get(k); !ok || got != want {
			t.Fatalf("final[%q] = %q,%v, reference wants %q", k, got, ok, want)
		}
	}
	for _, c := range script {
		for _, op := range c.ops {
			if _, want := ref.data[op.Key]; !want {
				if _, ok := final.Get(op.Key); ok {
					t.Fatalf("final[%q] present, reference says it must not be", op.Key)
				}
			}
		}
	}
}

// TestWriteBoundarySweep injects a crash at every single write boundary of
// a deterministic run and verifies each run against the reference model.
func TestWriteBoundarySweep(t *testing.T) {
	const window = 128
	var script []cmd
	add := func(p string, seq uint64) {
		script = append(script, cmd{p, seq, []Op{fxOp(p, seq)}})
	}
	add("A", 1)
	add("A", 2)
	add("A", 2)   // duplicate
	add("B", 10)  // other producer
	add("A", 200) // hole
	add("A", 150) // late hole fill
	add("A", 150) // duplicate
	add("A", 1)   // too old (200-1 >= 128)
	add("A", 72)  // too old (exactly at boundary)
	add("A", 73)  // still inside the window
	add("B", 10)  // duplicate
	add("B", 138) // jump
	add("B", 9)   // too old for B
	add("A", 201)
	add("A", 201) // duplicate

	probe := newFaultFile()
	drive(t, probe, window, script)
	boundaries := probe.count
	t.Logf("clean run crosses %d write boundaries", boundaries)

	for failAt := 0; failAt <= boundaries; failAt++ {
		t.Run(fmt.Sprintf("crash_at_%d", failAt), func(t *testing.T) {
			ff := newFaultFile()
			ff.failAt = failAt
			drive(t, ff, window, script)
		})
	}
}

// TestRandomizedCrashesVsReference hammers the DB with a random workload
// (gaps, duplicates, aged-out messages) and random power losses, including
// torn writes, checking everything against the reference model.
func TestRandomizedCrashesVsReference(t *testing.T) {
	const window = 128
	for seed := int64(0); seed < 20; seed++ {
		t.Run(fmt.Sprintf("seed_%d", seed), func(t *testing.T) {
			rnd := rand.New(rand.NewSource(seed))
			producers := []string{"p0", "p1", "p2"}
			next := map[string]uint64{"p0": 1, "p1": 1, "p2": 1}
			var script []cmd
			for i := 0; i < 300; i++ {
				p := producers[rnd.Intn(len(producers))]
				var seq uint64
				switch r := rnd.Intn(100); {
				case r < 55: // in-order delivery
					seq = next[p]
					next[p]++
				case r < 70: // gap forward
					next[p] += uint64(rnd.Intn(20)) + 1
					seq = next[p]
					next[p]++
				case r < 85 && next[p] > 1: // redeliver a recent message
					seq = next[p] - 1 - uint64(rnd.Intn(int(min64(next[p]-1, 40))))
				default: // something ancient: duplicate or too old
					seq = uint64(rnd.Intn(int(next[p]))) + 1
				}
				script = append(script, cmd{p, seq, []Op{fxOp(p, seq)}})
			}
			ff := newFaultFile()
			ff.torn = true
			ff.rnd = rnd
			// Crash at a few random boundaries, re-armed after each reopen.
			crashes := 1 + rnd.Intn(3)
			step := 2 + rnd.Intn(8)
			ff.failAt = rnd.Intn(step)
			driveWithSchedule(t, ff, window, script, rnd, crashes, step)
		})
	}
}

// driveWithSchedule is drive() but re-arms fault injection after every
// crash, allowing multiple power losses in one run.
func driveWithSchedule(t *testing.T, ff *faultFile, window int, script []cmd, rnd *rand.Rand, crashes, step int) {
	t.Helper()
	ref := newRefModel(window)
	db, err := OpenWithFile(ff, window)
	if err != nil {
		t.Fatal(err)
	}
	for i, c := range script {
		var dec Decision
		for {
			dec, err = db.Apply(c.producer, c.seq, c.ops...)
			if errors.Is(err, errCrash) {
				db.Close()
				snap := ff.snapshot()
				if crashes > 0 {
					crashes--
					snap.failAt = rnd.Intn(step)
					snap.torn = true
					snap.rnd = rnd
				}
				ff = snap
				db, err = OpenWithFile(ff, window)
				if err != nil {
					t.Fatal(err)
				}
				continue
			}
			if err != nil {
				t.Fatalf("cmd %d: unexpected error: %v", i, err)
			}
			break
		}
		if want := ref.apply(c.producer, c.seq, c.ops); dec != want {
			t.Fatalf("cmd %d (%s,%d): decision %v, reference says %v",
				i, c.producer, c.seq, dec, want)
		}
	}
	db.Close()
	final, err := OpenWithFile(ff.snapshot(), window)
	if err != nil {
		t.Fatal(err)
	}
	defer final.Close()
	for k, want := range ref.data {
		if got, ok := final.Get(k); !ok || got != want {
			t.Fatalf("final[%q] = %q,%v, reference wants %q", k, got, ok, want)
		}
	}
}

func min64(a, b uint64) uint64 {
	if a < b {
		return a
	}
	return b
}
