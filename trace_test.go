package debugtrace

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math/rand"
	"testing"
)

// machine is a deterministic test state machine. Its snapshot is a fixed
// 24-byte encoding so states can be compared byte-for-byte.
type machine struct {
	count    uint64
	acc      uint64
	hash     uint64
	applies  int // inputs applied since construction (instrumentation)
	restores int // snapshot restores (instrumentation)
}

const fnvBasis = 14695981039346656037

func newMachine() *machine {
	m := &machine{}
	m.Reset()
	return m
}

func (m *machine) Reset() {
	m.count, m.acc, m.hash = 0, 0, fnvBasis
}

func (m *machine) Apply(input []byte) {
	m.applies++
	for _, b := range input {
		m.hash ^= uint64(b)
		m.hash *= 1099511628211
		m.acc = m.acc*31 + uint64(b)
	}
	m.count++
}

func (m *machine) Snapshot() []byte {
	buf := make([]byte, 24)
	binary.BigEndian.PutUint64(buf[0:8], m.count)
	binary.BigEndian.PutUint64(buf[8:16], m.acc)
	binary.BigEndian.PutUint64(buf[16:24], m.hash)
	return buf
}

func (m *machine) Restore(snapshot []byte) error {
	if len(snapshot) != 24 {
		return fmt.Errorf("bad snapshot length %d", len(snapshot))
	}
	m.count = binary.BigEndian.Uint64(snapshot[0:8])
	m.acc = binary.BigEndian.Uint64(snapshot[8:16])
	m.hash = binary.BigEndian.Uint64(snapshot[16:24])
	m.restores++
	return nil
}

// replayFromStart computes the expected state at n by applying the first n
// recorded inputs to a fresh machine, ignoring all snapshots.
func replayFromStart(t *Trace, n uint64) []byte {
	m := newMachine()
	for i := uint64(0); i < n; i++ {
		e, err := t.Entry(i)
		if err != nil {
			panic(err)
		}
		if e.Kind == KindInput {
			m.Apply(e.Data)
		}
	}
	return m.Snapshot()
}

// buildTrace records numInputs random inputs, snapshotting every snapEvery
// inputs, and returns the trace.
func buildTrace(rng *rand.Rand, numInputs, snapEvery int) *Trace {
	tr := New()
	for i := 0; i < numInputs; i++ {
		in := make([]byte, 1+rng.Intn(16))
		rng.Read(in)
		tr.AppendInput(in)
		if snapEvery > 0 && (i+1)%snapEvery == 0 {
			// The state at this point is deterministic, so recompute it.
			tr.AppendSnapshot(replayFromStart(tr, uint64(tr.Len())))
		}
	}
	return tr
}

func TestRandomJumpsMatchFullReplay(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	tr := buildTrace(rng, 500, 7)
	if err := tr.Verify(); err != nil {
		t.Fatalf("fresh trace failed verification: %v", err)
	}
	m := newMachine()
	for i := 0; i < 300; i++ {
		n := uint64(rng.Intn(tr.Len() + 1))
		got, err := SnapshotAt(tr, n, m)
		if err != nil {
			t.Fatalf("jump to %d: %v", n, err)
		}
		want := replayFromStart(tr, n)
		if !bytes.Equal(got, want) {
			t.Fatalf("jump to %d: state mismatch\n got %x\nwant %x", n, got, want)
		}
	}
}

func TestJumpUsesNearestSnapshot(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	tr := buildTrace(rng, 100, 10) // snapshot every 10 inputs
	m := newMachine()
	target := uint64(105) // nearest snapshot is at seq 98, so replay is short
	if err := StateAt(tr, target, m); err != nil {
		t.Fatal(err)
	}
	if m.restores != 1 {
		t.Fatalf("expected 1 snapshot restore, got %d", m.restores)
	}
	if m.applies == 0 || m.applies >= 20 {
		t.Fatalf("expected short replay from nearest snapshot, applied %d inputs", m.applies)
	}
	want := replayFromStart(tr, target)
	if got := m.Snapshot(); !bytes.Equal(got, want) {
		t.Fatalf("state mismatch after snapshot jump\n got %x\nwant %x", got, want)
	}
}

func TestBranchDoesNotModifyOriginal(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	tr := buildTrace(rng, 200, 5)

	// Snapshot the original trace's blocks for later comparison.
	original := tr.Branch()

	branch := tr.Branch()
	for i := 0; i < 50; i++ {
		in := make([]byte, 8)
		rng.Read(in)
		branch.AppendInput(in)
		if i%6 == 0 {
			branch.AppendSnapshot(replayFromStart(branch, uint64(branch.Len())))
		}
	}

	// Original trace untouched by branch activity.
	if tr.Len() != original.Len() {
		t.Fatalf("original trace length changed: %d -> %d", original.Len(), tr.Len())
	}
	if !tr.EqualBytes(original) {
		t.Fatal("original trace blocks changed after branch appends")
	}
	if err := tr.Verify(); err != nil {
		t.Fatalf("original trace corrupted by branch: %v", err)
	}

	// Branch state must match a from-start replay of the branch itself,
	// byte-for-byte, at random jump targets.
	m := newMachine()
	for i := 0; i < 100; i++ {
		n := uint64(rng.Intn(branch.Len() + 1))
		got, err := SnapshotAt(branch, n, m)
		if err != nil {
			t.Fatalf("branch jump to %d: %v", n, err)
		}
		if want := replayFromStart(branch, n); !bytes.Equal(got, want) {
			t.Fatalf("branch jump to %d: mismatch\n got %x\nwant %x", n, got, want)
		}
	}

	// Appending to the original after branching must not affect the branch.
	branchLen := branch.Len()
	tr.AppendInput([]byte("late original input"))
	if branch.Len() != branchLen {
		t.Fatal("branch length changed after original append")
	}
}

func TestCorruptionIsLocatedNotGuessed(t *testing.T) {
	rng := rand.New(rand.NewSource(1234))
	tr := buildTrace(rng, 120, 9)

	corruptAt := uint64(57)
	tr.entries[corruptAt].Data[0] ^= 0xFF // damage the payload in place

	err := tr.Verify()
	if err == nil {
		t.Fatal("Verify missed corruption")
	}
	ce, ok := err.(*CorruptionError)
	if !ok {
		t.Fatalf("expected *CorruptionError, got %T: %v", err, err)
	}
	if ce.Seq != corruptAt {
		t.Fatalf("corruption located at seq %d, want %d", ce.Seq, corruptAt)
	}

	// A jump past the damage must fail and must not return guessed state.
	m := newMachine()
	if _, err := SnapshotAt(tr, corruptAt+10, m); !IsCorruption(err) {
		t.Fatalf("jump past corruption: expected CorruptionError, got %v", err)
	}
	if blank := newMachine(); m.count != blank.count || m.acc != blank.acc || m.hash != blank.hash {
		t.Fatal("machine left holding non-initial (guessed) state after failed jump")
	}

	// A jump to before the damage still succeeds.
	if _, err := SnapshotAt(tr, corruptAt, m); err != nil {
		t.Fatalf("jump before corruption should succeed: %v", err)
	}
}

func TestCorruptedChecksumField(t *testing.T) {
	rng := rand.New(rand.NewSource(5))
	tr := buildTrace(rng, 50, 4)
	tr.entries[20].CRC++ // tamper with the stored checksum only
	err := tr.Verify()
	ce, ok := err.(*CorruptionError)
	if !ok || ce.Seq != 20 {
		t.Fatalf("expected corruption at seq 20, got %v", err)
	}
}

func TestCorruptedSequenceField(t *testing.T) {
	rng := rand.New(rand.NewSource(6))
	tr := buildTrace(rng, 50, 4)
	tr.entries[33].Seq = 9999 // tamper with the stored sequence number
	err := tr.Verify()
	ce, ok := err.(*CorruptionError)
	if !ok || ce.Seq != 33 {
		t.Fatalf("expected corruption at seq 33, got %v", err)
	}
}

func TestBlocksAreImmutable(t *testing.T) {
	tr := New()
	buf := []byte("external-input")
	tr.AppendInput(buf)
	buf[0] = 'X' // caller mutates its buffer after recording
	e, err := tr.Entry(0)
	if err != nil {
		t.Fatal(err)
	}
	if string(e.Data) != "external-input" {
		t.Fatalf("stored input changed by caller mutation: %q", e.Data)
	}

	e.Data[0] = 'Y' // mutating the returned copy must not affect the trace
	again, err := tr.Entry(0)
	if err != nil {
		t.Fatal(err)
	}
	if string(again.Data) != "external-input" {
		t.Fatalf("stored input changed via returned entry: %q", again.Data)
	}
	if err := tr.Verify(); err != nil {
		t.Fatalf("trace failed verification after external mutation attempts: %v", err)
	}
}

func TestJumpOutOfRange(t *testing.T) {
	tr := New()
	tr.AppendInput([]byte("a"))
	m := newMachine()
	if err := StateAt(tr, 2, m); err == nil {
		t.Fatal("expected out-of-range error")
	}
}
