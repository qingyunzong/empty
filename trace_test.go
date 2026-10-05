package dbg

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"math/rand"
	"testing"
)

// hashApply is a deterministic transition with fixed-size states.
func hashApply(state, input []byte) []byte {
	h := sha256.New()
	h.Write(state)
	h.Write(input)
	return h.Sum(nil)
}

func replay(apply ApplyFunc, initial []byte, inputs [][]byte, n int) []byte {
	state := clone(initial)
	for i := 0; i < n; i++ {
		state = apply(state, inputs[i])
	}
	return state
}

func randInputs(rng *rand.Rand, n int) [][]byte {
	inputs := make([][]byte, n)
	for i := range inputs {
		b := make([]byte, 1+rng.Intn(24))
		rng.Read(b)
		inputs[i] = b
	}
	return inputs
}

// snapshotBlocks captures every byte of the block log for later comparison.
func snapshotBlocks(t *Trace) []block {
	out := make([]block, len(t.blocks))
	for i, blk := range t.blocks {
		out[i] = block{kind: blk.kind, seq: blk.seq, data: clone(blk.data), sum: blk.sum}
	}
	return out
}

func blocksEqual(a, b []block) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].kind != b[i].kind || a[i].seq != b[i].seq ||
			a[i].sum != b[i].sum || !bytes.Equal(a[i].data, b[i].data) {
			return false
		}
	}
	return true
}

func TestJumpMatchesFullReplay(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for trial := 0; trial < 20; trial++ {
		snapEvery := 1 + rng.Intn(50)
		n := 1 + rng.Intn(400)
		initial := make([]byte, 8)
		rng.Read(initial)
		inputs := randInputs(rng, n)

		tr := New(initial, hashApply, snapEvery)
		for _, in := range inputs {
			tr.Step(in)
		}
		if err := tr.Verify(); err != nil {
			t.Fatalf("trial %d: Verify: %v", trial, err)
		}
		if !bytes.Equal(tr.State(), replay(hashApply, initial, inputs, n)) {
			t.Fatalf("trial %d: live state diverges from full replay", trial)
		}

		posBefore := tr.Pos()
		for j := 0; j < 200; j++ {
			target := uint64(rng.Intn(n + 1))
			got, err := tr.Jump(target)
			if err != nil {
				t.Fatalf("trial %d: Jump(%d): %v", trial, target, err)
			}
			want := replay(hashApply, initial, inputs, int(target))
			if !bytes.Equal(got, want) {
				t.Fatalf("trial %d: Jump(%d) state differs from full replay", trial, target)
			}
		}
		if tr.Pos() != posBefore {
			t.Fatalf("trial %d: Jump moved the trace position", trial)
		}
	}
}

func TestBranchMatchesReplayAndKeepsOriginal(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	snapEvery := 7
	n := 300
	initial := make([]byte, 8)
	rng.Read(initial)
	inputs := randInputs(rng, n)

	tr := New(initial, hashApply, snapEvery)
	for _, in := range inputs {
		tr.Step(in)
	}
	before := snapshotBlocks(tr)
	stateBefore := tr.State()

	for trial := 0; trial < 30; trial++ {
		at := uint64(rng.Intn(n + 1))
		br, err := tr.Branch(at)
		if err != nil {
			t.Fatalf("trial %d: Branch(%d): %v", trial, at, err)
		}
		extra := randInputs(rng, 1+rng.Intn(100))
		for _, in := range extra {
			br.Step(in)
		}
		// Branch tip must equal an independent replay from the start.
		full := append(append([][]byte{}, inputs[:at]...), extra...)
		if want := replay(hashApply, initial, full, len(full)); !bytes.Equal(br.State(), want) {
			t.Fatalf("trial %d: branch state differs from full replay", trial)
		}
		// Random jumps inside the branch must match full replay as well.
		for j := 0; j < 50; j++ {
			target := uint64(rng.Intn(int(br.Pos()) + 1))
			got, err := br.Jump(target)
			if err != nil {
				t.Fatalf("trial %d: branch Jump(%d): %v", trial, target, err)
			}
			if want := replay(hashApply, initial, full, int(target)); !bytes.Equal(got, want) {
				t.Fatalf("trial %d: branch Jump(%d) differs from full replay", trial, target)
			}
		}
		if err := br.Verify(); err != nil {
			t.Fatalf("trial %d: branch Verify: %v", trial, err)
		}
	}

	// The original trajectory must be untouched, byte for byte.
	if !blocksEqual(before, snapshotBlocks(tr)) {
		t.Fatal("branching or branch steps modified the original block log")
	}
	if !bytes.Equal(stateBefore, tr.State()) {
		t.Fatal("branching modified the original current state")
	}
	if tr.Pos() != uint64(n) {
		t.Fatal("branching modified the original position")
	}
}

func TestCorruptionIsLocated(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	initial := make([]byte, 8)
	rng.Read(initial)
	inputs := randInputs(rng, 120)

	newTrace := func() *Trace {
		tr := New(initial, hashApply, 5)
		for _, in := range inputs {
			tr.Step(in)
		}
		return tr
	}

	// Corrupt an input block: jumps needing it must fail at its index.
	tr := newTrace()
	var inputIdx int
	for i, blk := range tr.blocks {
		if blk.kind == kindInput && blk.seq == 60 {
			inputIdx = i
		}
	}
	tr.blocks[inputIdx].data[0] ^= 0xFF
	if _, err := tr.Jump(100); err == nil {
		t.Fatal("Jump past corrupted input returned a state")
	} else {
		var ce *CorruptionError
		if !errors.As(err, &ce) || ce.Index != inputIdx {
			t.Fatalf("Jump error = %v, want CorruptionError at index %d", err, inputIdx)
		}
	}
	if !IsCorruption(tr.Verify()) {
		t.Fatal("Verify did not report corruption")
	}
	// A jump that does not need the corrupted block still succeeds.
	got, err := tr.Jump(10)
	if err != nil {
		t.Fatalf("Jump(10) before corrupted block: %v", err)
	}
	if want := replay(hashApply, initial, inputs, 10); !bytes.Equal(got, want) {
		t.Fatal("Jump(10) state differs from full replay")
	}

	// Corrupt a snapshot block: it must be located, not guessed around.
	tr = newTrace()
	snapIdx := tr.snaps[len(tr.snaps)/2]
	snapSeq := tr.blocks[snapIdx].seq
	tr.blocks[snapIdx].data[0] ^= 0xFF
	if _, err := tr.Jump(snapSeq + 2); err == nil {
		t.Fatal("Jump over corrupted snapshot returned a state")
	} else {
		var ce *CorruptionError
		if !errors.As(err, &ce) || ce.Index != snapIdx {
			t.Fatalf("Jump error = %v, want CorruptionError at index %d", err, snapIdx)
		}
	}

	// Corrupt the chain link itself: earliest corruption wins.
	tr = newTrace()
	tr.blocks[3].sum[0] ^= 0xFF
	tr.blocks[9].data[0] ^= 0xFF
	var ce *CorruptionError
	if err := tr.Verify(); !errors.As(err, &ce) || ce.Index != 3 {
		t.Fatalf("Verify error = %v, want CorruptionError at index 3", err)
	}

	// Branching from a corrupted prefix must refuse, not fork a guess.
	if _, err := tr.Branch(50); !IsCorruption(err) {
		t.Fatalf("Branch over corrupted prefix: err = %v", err)
	}
}

func TestJumpBeyondPosition(t *testing.T) {
	tr := New([]byte{1}, hashApply, 4)
	tr.Step([]byte{2})
	if _, err := tr.Jump(2); err == nil || IsCorruption(err) {
		t.Fatalf("Jump beyond position: err = %v", err)
	}
}

func TestRecordedDataIsImmutable(t *testing.T) {
	initial := []byte{0, 0, 0, 0}
	tr := New(initial, hashApply, 3)
	in := []byte{9, 9, 9}
	tr.Step(in)
	in[0] = 0xAA // caller mutation must not leak into the log
	s := tr.State()
	s[0] ^= 0xFF // mutating the returned state must not leak either

	got, err := tr.Jump(1)
	if err != nil {
		t.Fatal(err)
	}
	want := hashApply(clone(initial), []byte{9, 9, 9})
	if !bytes.Equal(got, want) {
		t.Fatal("recorded data was affected by caller-side mutation")
	}
	if err := tr.Verify(); err != nil {
		t.Fatal(err)
	}
}
