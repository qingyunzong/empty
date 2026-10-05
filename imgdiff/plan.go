package imgdiff

import "fmt"

// Op is one step of a migration plan. All steps are idempotent, so a
// plan interrupted after any step can resume by re-executing the
// current step. Steps are ordered so that old data still needed as a
// copy source is preserved (in the single scratch block) before the
// block holding it is overwritten.
type Op struct {
	Op     string `json:"op"` // save, copy, restore, zero, punch, write
	Block  int    `json:"block,omitempty"`
	Src    int    `json:"src,omitempty"`
	Dst    int    `json:"dst,omitempty"`
	Digest string `json:"digest,omitempty"`
}

// Plan describes how to rewrite an old image into a new one.
type Plan struct {
	Block uint64 `json:"block"`
	Steps []Op   `json:"steps"`
}

// blockState is the layout of one block: hole, zero data, or data with
// a content digest.
type blockState struct {
	hole   bool
	zero   bool
	digest string
}

func (s blockState) equal(o blockState) bool {
	return s.hole == o.hole && s.zero == o.zero && s.digest == o.digest
}

// blockStates splits a flattened extent list into per-block states.
// Extent boundaries must be aligned to block.
func blockStates(extents []Extent, nblocks int, block uint64) ([]blockState, error) {
	states := make([]blockState, nblocks)
	for i := range states {
		states[i] = blockState{hole: true}
	}
	for _, e := range extents {
		if e.Start%block != 0 || e.End%block != 0 {
			return nil, fmt.Errorf("extent [%d,%d) is not aligned to block size %d", e.Start, e.End, block)
		}
		for i := int(e.Start / block); i < int(e.End/block); i++ {
			if !e.Data {
				states[i] = blockState{hole: true}
			} else if e.Zero {
				states[i] = blockState{zero: true}
			} else {
				states[i] = blockState{digest: e.Digest}
			}
		}
	}
	return states, nil
}

// Action kinds for destination blocks.
const (
	actNone = iota
	actPunch
	actZero
	actCopy    // copy old block src to this block
	actRestore // copy the scratch block to this block
	actWrite   // write new content identified by digest
)

type action struct {
	kind   int
	src    int    // actCopy
	digest string // actWrite
}

// MakePlan computes a block-granular migration plan that rewrites the
// old image into the new image. Both images must have equal size, a
// size that is a multiple of block, and extents aligned to block.
// Source and destination blocks of copy steps may overlap arbitrarily;
// cyclic moves are broken with a single scratch block (save/restore).
// Content not present in the old image is fetched with write steps
// keyed by digest.
func MakePlan(old, new *Manifest, block uint64) (*Plan, error) {
	if block == 0 {
		return nil, fmt.Errorf("block size must be positive")
	}
	if old.Size != new.Size {
		return nil, fmt.Errorf("image sizes differ: %d vs %d", old.Size, new.Size)
	}
	if old.Size%block != 0 {
		return nil, fmt.Errorf("image size %d is not a multiple of block size %d", old.Size, block)
	}
	oldFlat, err := old.Flatten()
	if err != nil {
		return nil, fmt.Errorf("old image: %w", err)
	}
	newFlat, err := new.Flatten()
	if err != nil {
		return nil, fmt.Errorf("new image: %w", err)
	}
	nblocks := int(old.Size / block)
	oldSt, err := blockStates(oldFlat, nblocks, block)
	if err != nil {
		return nil, fmt.Errorf("old image: %w", err)
	}
	newSt, err := blockStates(newFlat, nblocks, block)
	if err != nil {
		return nil, fmt.Errorf("new image: %w", err)
	}

	actions := make([]action, nblocks)
	oldNeeded := make([]int, nblocks) // pending copies reading each old block
	for i := 0; i < nblocks; i++ {
		o, n := oldSt[i], newSt[i]
		if o.equal(n) {
			continue
		}
		switch {
		case n.hole:
			actions[i].kind = actPunch
		case n.zero:
			actions[i].kind = actZero
		default:
			src := -1
			for j := 0; j < nblocks; j++ {
				if !oldSt[j].hole && !oldSt[j].zero && oldSt[j].digest == n.digest {
					src = j
					break
				}
			}
			if src >= 0 {
				actions[i] = action{kind: actCopy, src: src}
				oldNeeded[src]++
			} else {
				actions[i] = action{kind: actWrite, digest: n.digest}
			}
		}
	}

	// A block may be overwritten once every pending reader of its old
	// content has completed. If no block is writable the remaining moves
	// contain a cycle: save one block of it into the scratch block and
	// redirect its readers to restore from scratch. The saved block then
	// unwinds the whole cycle, freeing the scratch block for the next
	// cycle, so a single scratch block always suffices.
	var steps []Op
	done := make([]bool, nblocks)
	remaining := 0
	for i := range actions {
		if actions[i].kind != actNone {
			remaining++
		}
	}
	scratchBusy := false
	scratchReaders := 0
	emit := func(i int) {
		a := actions[i]
		switch a.kind {
		case actPunch:
			steps = append(steps, Op{Op: "punch", Block: i})
		case actZero:
			steps = append(steps, Op{Op: "zero", Block: i})
		case actCopy:
			steps = append(steps, Op{Op: "copy", Src: a.src, Dst: i})
			oldNeeded[a.src]--
		case actRestore:
			steps = append(steps, Op{Op: "restore", Dst: i})
			scratchReaders--
			if scratchReaders == 0 {
				scratchBusy = false
			}
		case actWrite:
			steps = append(steps, Op{Op: "write", Block: i, Digest: a.digest})
		}
		done[i] = true
		remaining--
	}
	for remaining > 0 {
		progressed := false
		for i := 0; i < nblocks; i++ {
			if done[i] || actions[i].kind == actNone || oldNeeded[i] > 0 {
				continue
			}
			emit(i)
			progressed = true
		}
		if progressed {
			continue
		}
		if scratchBusy {
			return nil, fmt.Errorf("internal error: plan requires a second scratch block")
		}
		picked := -1
		for i := 0; i < nblocks; i++ {
			if !done[i] && actions[i].kind != actNone && oldNeeded[i] > 0 {
				picked = i
				break
			}
		}
		if picked < 0 {
			return nil, fmt.Errorf("internal error: no cycle to break")
		}
		steps = append(steps, Op{Op: "save", Block: picked})
		scratchBusy = true
		for i := 0; i < nblocks; i++ {
			if !done[i] && actions[i].kind == actCopy && actions[i].src == picked {
				actions[i] = action{kind: actRestore}
				scratchReaders++
			}
		}
		oldNeeded[picked] = 0
	}
	return &Plan{Block: block, Steps: steps}, nil
}
