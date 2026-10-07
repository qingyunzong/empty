package imgdiff

import (
	"bytes"
	"errors"
	"fmt"
)

// Machine independently executes a relocation Plan on an in-memory image.
// It is the checker, not the planner: it verifies source hashes so a cyclic
// relocation can never silently overwrite an unsaved source, enforces the
// single staging block, and keeps the parent snapshot store separate so any
// corruption of shared data is detected.
type Machine struct {
	BlockSize uint64
	blocks    []mblock
	parent    [][]byte // parent snapshot content per block, nil if not shared
	staging   []byte
	hasStage  bool
	Next      int // index of the next plan step to execute (the journal)
}

type mblock struct {
	hole   bool
	shared bool
	data   []byte
}

// NewMachine builds a machine holding the old image. Shared data blocks are
// backed by the parent snapshot store; writing them requires OpUnshare.
func NewMachine(old *Image, blockSize uint64) (*Machine, error) {
	ob, err := blocksOf(old, blockSize)
	if err != nil {
		return nil, err
	}
	m := &Machine{BlockSize: blockSize}
	for _, b := range ob {
		mb := mblock{hole: b.hole, shared: b.shared}
		if !b.hole {
			mb.data = append([]byte(nil), b.data...)
		}
		if b.shared {
			m.parent = append(m.parent, append([]byte(nil), b.data...))
		} else {
			m.parent = append(m.parent, nil)
		}
		m.blocks = append(m.blocks, mb)
	}
	return m, nil
}

// parentSnapshot returns a copy of the parent store for later comparison.
func (m *Machine) parentSnapshot() [][]byte {
	out := make([][]byte, len(m.parent))
	for i, p := range m.parent {
		out[i] = append([]byte(nil), p...)
	}
	return out
}

// Step executes the next plan step. Steps are idempotent: re-executing the
// step at m.Next after an interruption is safe and converges to the same
// state, because no step modifies its own source.
func (m *Machine) Step(plan *Plan) error {
	if m.Next >= len(plan.Steps) {
		return errors.New("imgdiff: plan exhausted")
	}
	if err := m.apply(plan.Steps[m.Next]); err != nil {
		return fmt.Errorf("imgdiff: step %d: %w", m.Next, err)
	}
	m.Next++
	return nil
}

// Run executes all remaining steps.
func (m *Machine) Run(plan *Plan) error {
	for m.Next < len(plan.Steps) {
		if err := m.Step(plan); err != nil {
			return err
		}
	}
	return nil
}

func (m *Machine) apply(s Step) error {
	checkDst := func(d int) error {
		if d < 0 || d >= len(m.blocks) {
			return fmt.Errorf("block index %d out of range", d)
		}
		return nil
	}
	switch s.Op {
	case OpUnshare:
		if err := checkDst(s.Dst); err != nil {
			return err
		}
		b := &m.blocks[s.Dst]
		if b.hole || m.parent[s.Dst] == nil {
			return fmt.Errorf("unshare: block %d is not shared data", s.Dst)
		}
		// Idempotent: re-executing after a partial copy repairs the block
		// from the untouched parent snapshot.
		b.data = append([]byte(nil), m.parent[s.Dst]...)
		b.shared = false
	case OpMove:
		if err := checkDst(s.Src); err != nil {
			return err
		}
		if err := checkDst(s.Dst); err != nil {
			return err
		}
		src := &m.blocks[s.Src]
		if src.hole {
			return fmt.Errorf("move: source block %d is a hole", s.Src)
		}
		if got := HashContent(src.data); got != s.SrcHash {
			return fmt.Errorf("move: source block %d content hash %016x, want %016x: unsaved source overwritten", s.Src, got, s.SrcHash)
		}
		dst := &m.blocks[s.Dst]
		if dst.shared {
			return fmt.Errorf("move: target block %d still shared with parent snapshot", s.Dst)
		}
		dst.hole = false
		dst.data = append([]byte(nil), src.data...)
	case OpWrite:
		if err := checkDst(s.Dst); err != nil {
			return err
		}
		if uint64(len(s.Data)) != m.BlockSize {
			return fmt.Errorf("write: %d bytes, block size is %d", len(s.Data), m.BlockSize)
		}
		dst := &m.blocks[s.Dst]
		if dst.shared {
			return fmt.Errorf("write: target block %d still shared with parent snapshot", s.Dst)
		}
		dst.hole = false
		dst.data = append([]byte(nil), s.Data...)
	case OpPunch:
		if err := checkDst(s.Dst); err != nil {
			return err
		}
		b := &m.blocks[s.Dst]
		b.hole, b.shared, b.data = true, false, nil
	case OpStageSave:
		if err := checkDst(s.Src); err != nil {
			return err
		}
		if m.hasStage {
			if HashContent(m.staging) == s.SrcHash {
				return nil // already saved; journal lost the completion
			}
			return errors.New("stage-save: staging block already in use")
		}
		src := &m.blocks[s.Src]
		if src.hole {
			return fmt.Errorf("stage-save: source block %d is a hole", s.Src)
		}
		if got := HashContent(src.data); got != s.SrcHash {
			return fmt.Errorf("stage-save: source block %d content hash %016x, want %016x: unsaved source overwritten", s.Src, got, s.SrcHash)
		}
		m.staging = append([]byte(nil), src.data...)
		m.hasStage = true
	case OpStageLoad:
		if err := checkDst(s.Dst); err != nil {
			return err
		}
		if !m.hasStage {
			// Already applied before the interruption? Accept only if the
			// target already holds the staged content.
			if b := &m.blocks[s.Dst]; !b.hole && HashContent(b.data) == s.SrcHash {
				return nil
			}
			return errors.New("stage-load: staging block is empty")
		}
		dst := &m.blocks[s.Dst]
		if dst.shared {
			return fmt.Errorf("stage-load: target block %d still shared with parent snapshot", s.Dst)
		}
		if got := HashContent(m.staging); got != s.SrcHash {
			return fmt.Errorf("stage-load: staging content hash %016x, want %016x", got, s.SrcHash)
		}
		dst.hole = false
		dst.data = append([]byte(nil), m.staging...)
		m.staging = nil
		m.hasStage = false
	default:
		return fmt.Errorf("unknown op %d", int(s.Op))
	}
	return nil
}

// Verify checks the machine state against the new image: exact content and
// hole layout per block, parent snapshot untouched, staging released.
func (m *Machine) Verify(newImg *Image, parentBefore [][]byte) error {
	nb, err := blocksOf(newImg, m.BlockSize)
	if err != nil {
		return err
	}
	if len(nb) != len(m.blocks) {
		return fmt.Errorf("imgdiff: block count %d, want %d", len(m.blocks), len(nb))
	}
	for i, want := range nb {
		got := m.blocks[i]
		if got.hole != want.hole {
			return fmt.Errorf("imgdiff: block %d: hole=%v, want hole=%v", i, got.hole, want.hole)
		}
		if !want.hole && !bytes.Equal(got.data, want.data) {
			return fmt.Errorf("imgdiff: block %d: content mismatch", i)
		}
	}
	if len(parentBefore) != len(m.parent) {
		return errors.New("imgdiff: parent store resized")
	}
	for i := range m.parent {
		if !bytes.Equal(parentBefore[i], m.parent[i]) {
			return fmt.Errorf("imgdiff: parent snapshot block %d corrupted", i)
		}
	}
	if m.hasStage {
		return errors.New("imgdiff: staging block still occupied at plan end")
	}
	return nil
}

// VerifyPlan is the full independent check: build a machine from old,
// execute the plan, verify the result matches new and the parent snapshot.
func VerifyPlan(old, newImg *Image, plan *Plan) error {
	m, err := NewMachine(old, plan.BlockSize)
	if err != nil {
		return err
	}
	before := m.parentSnapshot()
	if err := m.Run(plan); err != nil {
		return err
	}
	return m.Verify(newImg, before)
}

// Image renders the machine's current logical content as a flat byte slice
// (holes as zeros). Intended for small images and tests.
func (m *Machine) Image() []byte {
	out := make([]byte, 0, uint64(len(m.blocks))*m.BlockSize)
	zeros := make([]byte, m.BlockSize)
	for _, b := range m.blocks {
		if b.hole {
			out = append(out, zeros...)
		} else {
			out = append(out, b.data...)
		}
	}
	return out
}

// CorruptTarget simulates an interruption in the middle of step k by
// scrambling the bytes the step was writing. Re-executing the step must
// repair the state. Only the write target is touched, never a source.
func (m *Machine) CorruptTarget(s Step) {
	scramble := func(b []byte) {
		for i := range b {
			b[i] ^= 0xA5
		}
	}
	switch s.Op {
	case OpMove, OpWrite, OpStageLoad:
		if s.Dst >= 0 && s.Dst < len(m.blocks) && !m.blocks[s.Dst].hole && !m.blocks[s.Dst].shared {
			scramble(m.blocks[s.Dst].data)
		}
	case OpUnshare:
		if s.Dst >= 0 && s.Dst < len(m.blocks) && !m.blocks[s.Dst].shared && !m.blocks[s.Dst].hole {
			scramble(m.blocks[s.Dst].data)
		}
	case OpStageSave:
		if m.hasStage {
			scramble(m.staging)
		}
	case OpPunch:
		// A partial punch leaves either a hole or the old data; both are
		// fixed by re-executing the idempotent punch.
	}
}
