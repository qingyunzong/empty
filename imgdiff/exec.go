package imgdiff

import (
	"bytes"
	"fmt"
)

// Disk is a block device with a hole map: unallocated blocks read as
// zero. It models the persistent state of an image during migration.
type Disk struct {
	BlockSize int
	Data      []byte // len == Blocks()*BlockSize; garbage where unallocated
	Alloc     []bool
}

// NewDisk returns a fully sparse disk of nblocks blocks.
func NewDisk(nblocks, blockSize int) *Disk {
	return &Disk{
		BlockSize: blockSize,
		Data:      make([]byte, nblocks*blockSize),
		Alloc:     make([]bool, nblocks),
	}
}

// Blocks returns the number of blocks.
func (d *Disk) Blocks() int { return len(d.Alloc) }

// ReadBlock returns the logical content of block i (zeros for holes).
func (d *Disk) ReadBlock(i int) []byte {
	out := make([]byte, d.BlockSize)
	if d.Alloc[i] {
		copy(out, d.Data[i*d.BlockSize:(i+1)*d.BlockSize])
	}
	return out
}

// WriteBlock allocates block i with the given content.
func (d *Disk) WriteBlock(i int, content []byte) {
	copy(d.Data[i*d.BlockSize:(i+1)*d.BlockSize], content)
	d.Alloc[i] = true
}

// Punch deallocates block i, turning it into a hole.
func (d *Disk) Punch(i int) { d.Alloc[i] = false }

// Clone deep-copies the disk.
func (d *Disk) Clone() *Disk {
	out := &Disk{BlockSize: d.BlockSize}
	out.Data = append([]byte(nil), d.Data...)
	out.Alloc = append([]bool(nil), d.Alloc...)
	return out
}

// Equal reports whether two disks have identical logical content and
// identical hole layout.
func (d *Disk) Equal(o *Disk) bool {
	if d.BlockSize != o.BlockSize || len(d.Alloc) != len(o.Alloc) {
		return false
	}
	for i := range d.Alloc {
		if d.Alloc[i] != o.Alloc[i] {
			return false
		}
		if d.Alloc[i] && !bytes.Equal(d.ReadBlock(i), o.ReadBlock(i)) {
			return false
		}
	}
	return true
}

// State is the persistent state of a plan execution: the disk, the
// single scratch block, and the journal recording how many steps have
// completed. It survives crashes; everything else is volatile.
type State struct {
	Disk         *Disk
	Scratch      []byte
	ScratchValid bool
	Next         int // journal: steps [0, Next) are complete
}

// NewState returns the initial state for migrating disk.
func NewState(disk *Disk) *State {
	return &State{Disk: disk, Scratch: make([]byte, disk.BlockSize)}
}

// Executor applies a plan to persistent State. Source maps content
// digests to block contents for write steps (new data not present in
// the old image).
type Executor struct {
	St     *State
	Plan   *Plan
	Source map[string][]byte
}

// Done reports whether the plan has finished.
func (e *Executor) Done() bool { return e.St.Next >= len(e.Plan.Steps) }

// Step executes the next step and journals it. Every step is
// idempotent: re-executing the current step after a crash (whether it
// completed or was applied but not yet journaled) is safe, because a
// step never destroys data that later steps still read.
func (e *Executor) Step() error {
	if e.Done() {
		return fmt.Errorf("plan already complete")
	}
	op := e.Plan.Steps[e.St.Next]
	d := e.St.Disk
	switch op.Op {
	case "save":
		copy(e.St.Scratch, d.ReadBlock(op.Block))
		e.St.ScratchValid = true
	case "copy":
		d.WriteBlock(op.Dst, d.ReadBlock(op.Src))
	case "restore":
		if !e.St.ScratchValid {
			return fmt.Errorf("step %d: restore with empty scratch block", e.St.Next)
		}
		d.WriteBlock(op.Dst, e.St.Scratch)
	case "zero":
		d.WriteBlock(op.Block, make([]byte, d.BlockSize))
	case "punch":
		d.Punch(op.Block)
	case "write":
		content, ok := e.Source[op.Digest]
		if !ok {
			return fmt.Errorf("step %d: no source content for digest %q", e.St.Next, op.Digest)
		}
		if len(content) != d.BlockSize {
			return fmt.Errorf("step %d: source content for digest %q has %d bytes, want %d", e.St.Next, op.Digest, len(content), d.BlockSize)
		}
		d.WriteBlock(op.Block, content)
	default:
		return fmt.Errorf("step %d: unknown op %q", e.St.Next, op.Op)
	}
	e.St.Next++
	return nil
}

// Run executes all remaining steps.
func (e *Executor) Run() error {
	for !e.Done() {
		if err := e.Step(); err != nil {
			return err
		}
	}
	return nil
}

// VerifyPlan independently checks that a plan rewrites the old image
// into the new image without ever overwriting a source that is still
// needed, using at most one scratch block. It simulates symbolic block
// contents and validates every step, then requires the final layout
// and content to match the new image exactly.
func VerifyPlan(old, new *Manifest, plan *Plan) error {
	oldFlat, err := old.Flatten()
	if err != nil {
		return fmt.Errorf("old image: %w", err)
	}
	newFlat, err := new.Flatten()
	if err != nil {
		return fmt.Errorf("new image: %w", err)
	}
	if old.Size != new.Size || old.Size%plan.Block != 0 || plan.Block == 0 {
		return fmt.Errorf("size %d/%d not compatible with block %d", old.Size, new.Size, plan.Block)
	}
	nblocks := int(old.Size / plan.Block)
	oldSt, err := blockStates(oldFlat, nblocks, plan.Block)
	if err != nil {
		return err
	}
	newSt, err := blockStates(newFlat, nblocks, plan.Block)
	if err != nil {
		return err
	}
	id := func(s blockState) string {
		switch {
		case s.hole:
			return "hole"
		case s.zero:
			return "zero"
		default:
			return "data:" + s.digest
		}
	}
	cur := make([]string, nblocks)
	want := make([]string, nblocks)
	for i := range cur {
		cur[i] = id(oldSt[i])
		want[i] = id(newSt[i])
	}
	// readsAfter[t][b] counts copy steps after t that read block b.
	readsAfter := make([][]int, len(plan.Steps)+1)
	readsAfter[len(plan.Steps)] = make([]int, nblocks)
	for t := len(plan.Steps) - 1; t >= 0; t-- {
		readsAfter[t] = append([]int(nil), readsAfter[t+1]...)
		if plan.Steps[t].Op == "copy" {
			src := plan.Steps[t].Src
			if src < 0 || src >= nblocks {
				return fmt.Errorf("step %d: copy source block %d out of range", t, src)
			}
			readsAfter[t][src]++
		}
	}
	scratchFree := true
	scratchID := ""
	pendingRestores := 0
	for _, op := range plan.Steps {
		if op.Op == "restore" {
			pendingRestores++
		}
	}
	checkBlock := func(t, b int) error {
		if b < 0 || b >= nblocks {
			return fmt.Errorf("step %d: block %d out of range [0,%d)", t, b, nblocks)
		}
		return nil
	}
	// overwrite checks that writing block b at step t does not destroy
	// old content that later steps still read.
	overwrite := func(t, b int) error {
		if err := checkBlock(t, b); err != nil {
			return err
		}
		if readsAfter[t+1][b] > 0 {
			return fmt.Errorf("step %d: block %d is overwritten but %d later step(s) still read it", t, b, readsAfter[t+1][b])
		}
		return nil
	}
	for t, op := range plan.Steps {
		switch op.Op {
		case "save":
			if err := checkBlock(t, op.Block); err != nil {
				return err
			}
			if !scratchFree {
				return fmt.Errorf("step %d: save needs a second scratch block", t)
			}
			scratchID = cur[op.Block]
			scratchFree = false
		case "copy":
			if err := overwrite(t, op.Dst); err != nil {
				return err
			}
			if cur[op.Src] != want[op.Dst] {
				return fmt.Errorf("step %d: copy source block %d holds %q, destination %d wants %q", t, op.Src, cur[op.Src], op.Dst, want[op.Dst])
			}
			cur[op.Dst] = cur[op.Src]
		case "restore":
			if err := overwrite(t, op.Dst); err != nil {
				return err
			}
			if scratchFree {
				return fmt.Errorf("step %d: restore with empty scratch block", t)
			}
			if scratchID != want[op.Dst] {
				return fmt.Errorf("step %d: scratch holds %q, destination %d wants %q", t, scratchID, op.Dst, want[op.Dst])
			}
			cur[op.Dst] = scratchID
			pendingRestores--
			if pendingRestores == 0 {
				scratchFree = true
			}
		case "zero":
			if err := overwrite(t, op.Block); err != nil {
				return err
			}
			if want[op.Block] != "zero" {
				return fmt.Errorf("step %d: zeroing block %d but new image wants %q", t, op.Block, want[op.Block])
			}
			cur[op.Block] = "zero"
		case "punch":
			if err := overwrite(t, op.Block); err != nil {
				return err
			}
			if want[op.Block] != "hole" {
				return fmt.Errorf("step %d: punching block %d but new image wants %q", t, op.Block, want[op.Block])
			}
			cur[op.Block] = "hole"
		case "write":
			if err := overwrite(t, op.Block); err != nil {
				return err
			}
			if want[op.Block] != "data:"+op.Digest {
				return fmt.Errorf("step %d: writing %q to block %d but new image wants %q", t, op.Digest, op.Block, want[op.Block])
			}
			cur[op.Block] = "data:" + op.Digest
		default:
			return fmt.Errorf("step %d: unknown op %q", t, op.Op)
		}
	}
	for i := range cur {
		if cur[i] != want[i] {
			return fmt.Errorf("block %d: plan leaves %q, new image wants %q", i, cur[i], want[i])
		}
	}
	return nil
}
