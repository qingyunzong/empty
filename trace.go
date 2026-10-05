// Package dbg implements a record/replay debugging trace.
//
// A Trace records external inputs as immutable blocks and periodically
// stores immutable state snapshot blocks. Every block carries a checksum
// chained to its predecessor, so corruption is located precisely instead
// of silently yielding a guessed state. Jumping to an earlier step
// restores the nearest snapshot at or before the target and replays the
// recorded inputs from there. Branching forks a new trace that shares the
// immutable prefix blocks and never mutates the original trajectory.
package dbg

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
)

// ApplyFunc is the deterministic state transition of the debugged program:
// given the current state and one external input it returns the next state.
// It must not retain or mutate its arguments.
type ApplyFunc func(state, input []byte) []byte

type blockKind byte

const (
	kindInput    blockKind = 1
	kindSnapshot blockKind = 2
)

// block is an immutable recorded unit. Once appended to a trace its fields
// are never modified; data is owned by the block.
type block struct {
	kind blockKind
	seq  uint64 // logical step the block belongs to (inputs: step they produce)
	data []byte
	sum  [sha256.Size]byte // checksum chained over the previous block
}

func sumBlock(kind blockKind, seq uint64, data []byte, prev [sha256.Size]byte) [sha256.Size]byte {
	h := sha256.New()
	h.Write(prev[:])
	h.Write([]byte{byte(kind)})
	var seqBuf [8]byte
	binary.BigEndian.PutUint64(seqBuf[:], seq)
	h.Write(seqBuf[:])
	h.Write(data)
	var out [sha256.Size]byte
	copy(out[:], h.Sum(nil))
	return out
}

// CorruptionError identifies the first block whose stored checksum does not
// match its contents. It is returned instead of any guessed state.
type CorruptionError struct {
	Index int    // position of the corrupted block in the trace log
	Seq   uint64 // logical step of the corrupted block
}

func (e *CorruptionError) Error() string {
	return fmt.Sprintf("dbg: corrupted block at log index %d (step %d)", e.Index, e.Seq)
}

// IsCorruption reports whether err is a *CorruptionError.
func IsCorruption(err error) bool {
	var ce *CorruptionError
	return errors.As(err, &ce)
}

// Trace is an append-only record of a deterministic execution.
type Trace struct {
	apply     ApplyFunc
	snapEvery int
	blocks    []block
	snaps     []int // log indices of snapshot blocks, ascending seq
	state     []byte
	pos       uint64 // number of steps applied so far
}

// New starts a trace whose state at step 0 is initial. A snapshot block is
// stored every snapEvery steps (values < 1 are treated as 1).
func New(initial []byte, apply ApplyFunc, snapEvery int) *Trace {
	if snapEvery < 1 {
		snapEvery = 1
	}
	t := &Trace{apply: apply, snapEvery: snapEvery}
	t.appendSnapshot(0, initial)
	t.state = clone(initial)
	return t
}

func clone(b []byte) []byte {
	out := make([]byte, len(b))
	copy(out, b)
	return out
}

func (t *Trace) appendBlock(kind blockKind, seq uint64, data []byte) {
	var prev [sha256.Size]byte
	if n := len(t.blocks); n > 0 {
		prev = t.blocks[n-1].sum
	}
	blk := block{kind: kind, seq: seq, data: clone(data)}
	blk.sum = sumBlock(kind, seq, blk.data, prev)
	t.blocks = append(t.blocks, blk)
}

func (t *Trace) appendSnapshot(seq uint64, state []byte) {
	t.appendBlock(kindSnapshot, seq, state)
	t.snaps = append(t.snaps, len(t.blocks)-1)
}

// Step records one external input and advances the execution by one step.
// The input slice is copied; the caller may reuse it afterwards.
func (t *Trace) Step(input []byte) {
	t.appendBlock(kindInput, t.pos+1, input)
	t.state = t.apply(t.state, clone(input))
	t.pos++
	if t.pos%uint64(t.snapEvery) == 0 {
		t.appendSnapshot(t.pos, t.state)
	}
}

// Pos returns the number of steps applied so far.
func (t *Trace) Pos() uint64 { return t.pos }

// State returns a copy of the current state.
func (t *Trace) State() []byte { return clone(t.state) }

// verifyPrefix recomputes the checksum chain over blocks[:upto] and returns
// a *CorruptionError locating the first mismatch.
func (t *Trace) verifyPrefix(upto int) error {
	var prev [sha256.Size]byte
	for i := 0; i < upto; i++ {
		blk := &t.blocks[i]
		if sumBlock(blk.kind, blk.seq, blk.data, prev) != blk.sum {
			return &CorruptionError{Index: i, Seq: blk.seq}
		}
		prev = blk.sum
	}
	return nil
}

// Verify checks the integrity of every recorded block and locates the first
// corrupted one, if any.
func (t *Trace) Verify() error { return t.verifyPrefix(len(t.blocks)) }

// Jump returns the state at the given earlier step. It verifies the
// integrity of every block needed for the replay, restores the nearest
// snapshot at or before target, and re-applies the recorded inputs from
// there. If any needed block is corrupted it returns a *CorruptionError
// locating the block and no state. Blocks after target are not needed and
// therefore not checked. Jump does not move the trace position.
func (t *Trace) Jump(target uint64) ([]byte, error) {
	if target > t.pos {
		return nil, fmt.Errorf("dbg: jump target %d beyond recorded position %d", target, t.pos)
	}
	si := sort.Search(len(t.snaps), func(i int) bool {
		return t.blocks[t.snaps[i]].seq > target
	}) - 1
	sn := t.snaps[si]

	last := sn
	for last+1 < len(t.blocks) && t.blocks[last+1].seq <= target {
		last++
	}
	if err := t.verifyPrefix(last + 1); err != nil {
		return nil, err
	}

	state := clone(t.blocks[sn].data)
	for i := sn + 1; i <= last; i++ {
		if t.blocks[i].kind == kindInput {
			state = t.apply(state, t.blocks[i].data)
		}
	}
	return state, nil
}

// Branch forks the trace at the given step. The branch shares the immutable
// prefix blocks with the original; subsequent steps on either trace never
// modify the other's trajectory. The integrity of the shared prefix is
// verified before forking.
func (t *Trace) Branch(at uint64) (*Trace, error) {
	state, err := t.Jump(at)
	if err != nil {
		return nil, err
	}
	cut := 0
	for cut < len(t.blocks) && t.blocks[cut].seq <= at {
		cut++
	}
	b := &Trace{
		apply:     t.apply,
		snapEvery: t.snapEvery,
		blocks:    make([]block, cut),
		state:     state,
		pos:       at,
	}
	copy(b.blocks, t.blocks[:cut])
	for i := range b.blocks {
		if b.blocks[i].kind == kindSnapshot {
			b.snaps = append(b.snaps, i)
		}
	}
	return b, nil
}
