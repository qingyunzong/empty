package imgdiff

import (
	"errors"
	"fmt"
	"hash/fnv"
)

// Op is a relocation plan operation. All offsets are block indices.
type Op int

const (
	// OpMove copies block Src to block Dst. Src keeps its content.
	OpMove Op = iota
	// OpWrite writes literal Data to block Dst (content not in old image).
	OpWrite
	// OpPunch turns block Dst into a hole.
	OpPunch
	// OpUnshare copies parent snapshot content of block Dst into private
	// storage, making the block writable without corrupting the parent.
	OpUnshare
	// OpStageSave copies block Src into the single staging block.
	OpStageSave
	// OpStageLoad writes the staging block to block Dst, freeing staging.
	OpStageLoad
)

func (op Op) String() string {
	switch op {
	case OpMove:
		return "move"
	case OpWrite:
		return "write"
	case OpPunch:
		return "punch"
	case OpUnshare:
		return "unshare"
	case OpStageSave:
		return "stage-save"
	case OpStageLoad:
		return "stage-load"
	}
	return "unknown"
}

// Step is one relocation step. Src/Dst are block indices (-1 when unused).
// SrcHash is the expected content hash of the source block, letting an
// executor verify that no cyclic relocation overwrites an unsaved source.
// For OpStageLoad, SrcHash is the expected hash of the staging block.
// Every step is idempotent, so a journal of completed steps suffices to
// resume after an interruption at any point.
type Step struct {
	Op      Op
	Src     int
	Dst     int
	Data    []byte // OpWrite only
	SrcHash uint64 // OpMove and OpStageSave only
}

func (s Step) String() string {
	switch s.Op {
	case OpMove, OpStageSave:
		return fmt.Sprintf("%s %d -> %d (srchash %016x)", s.Op, s.Src, s.Dst, s.SrcHash)
	case OpStageLoad:
		return fmt.Sprintf("%s -> %d (srchash %016x)", s.Op, s.Dst, s.SrcHash)
	case OpPunch, OpUnshare:
		return fmt.Sprintf("%s -> %d", s.Op, s.Dst)
	case OpWrite:
		return fmt.Sprintf("write -> %d (%d bytes)", s.Dst, len(s.Data))
	}
	return s.Op.String()
}

// Plan transforms the old image into the new image block by block.
type Plan struct {
	BlockSize uint64
	Steps     []Step
}

// HashContent hashes block content for SrcHash.
func HashContent(b []byte) uint64 {
	h := fnv.New64a()
	h.Write(b)
	return h.Sum64()
}

type blockInfo struct {
	hole   bool
	shared bool
	data   []byte // nil when hole
}

// blocksOf splits an image into block-size cells. Extents must be aligned.
func blocksOf(img *Image, blockSize uint64) ([]blockInfo, error) {
	if blockSize == 0 {
		return nil, errors.New("imgdiff: block size must be > 0")
	}
	if img.Size%blockSize != 0 {
		return nil, fmt.Errorf("imgdiff: image size %d not a multiple of block size %d", img.Size, blockSize)
	}
	n := img.Size / blockSize
	if n > uint64(maxInt) {
		return nil, fmt.Errorf("imgdiff: %d blocks too many", n)
	}
	blocks := make([]blockInfo, n)
	for i := range blocks {
		blocks[i].hole = true
	}
	for _, e := range img.Extents {
		if e.Start%blockSize != 0 || e.Len%blockSize != 0 {
			return nil, fmt.Errorf("imgdiff: extent [%d, %d) not aligned to block size %d", e.Start, e.End(), blockSize)
		}
		for off := e.Start; off < e.End(); off += blockSize {
			b := &blocks[off/blockSize]
			switch e.Kind {
			case Hole:
				b.hole, b.shared, b.data = true, false, nil
			case Data:
				chunk := e.Data[off-e.Start : off-e.Start+blockSize]
				b.hole, b.shared, b.data = false, e.Shared, chunk
			}
		}
	}
	return blocks, nil
}

const maxInt = int(^uint(0) >> 1)

// equalContent reports whether old block o already satisfies new block n.
func equalContent(o, n blockInfo) bool {
	if o.hole != n.hole {
		return false
	}
	if o.hole {
		return true
	}
	if len(o.data) != len(n.data) {
		return false
	}
	for i := range o.data {
		if o.data[i] != n.data[i] {
			return false
		}
	}
	return true
}

// pending move in the relocation graph. src == -1 marks a deferred
// stage-load (source is the staging block).
type pmove struct {
	src, dst int
	load     bool // deferred OpStageLoad
	done     bool
	hash     uint64 // saved-block content hash, for deferred stage-loads
}

// BuildPlan computes a relocation plan transforming old into new.
//
// Requirements: old and new validate, have equal sizes, the size is a
// multiple of blockSize, and all extents are block-aligned. Source and
// target ranges of moves may overlap arbitrarily; cycles are broken with
// the single staging block. Old data that is still needed is always saved
// (staging) or consumed (move) before its block is overwritten. Shared
// blocks are unshared before being written, so the parent snapshot is
// never corrupted.
func BuildPlan(old, newImg *Image, blockSize uint64) (*Plan, error) {
	if err := old.Validate(); err != nil {
		return nil, err
	}
	if err := newImg.Validate(); err != nil {
		return nil, err
	}
	if old.Size != newImg.Size {
		return nil, fmt.Errorf("imgdiff: size mismatch: old %d, new %d", old.Size, newImg.Size)
	}
	ob, err := blocksOf(old, blockSize)
	if err != nil {
		return nil, err
	}
	nb, err := blocksOf(newImg, blockSize)
	if err != nil {
		return nil, err
	}

	n := len(ob)
	// Index old data blocks by content for source lookup.
	byContent := make(map[string][]int)
	for i, b := range ob {
		if !b.hole {
			byContent[string(b.data)] = append(byContent[string(b.data)], i)
		}
	}
	usedSrc := make([]bool, n)

	var moves []*pmove
	var writes []Step
	var punches []int
	writer := make([]int, n) // move index writing block, -1 if none
	reader := make([]int, n) // move index reading block, -1 if none
	for i := range writer {
		writer[i], reader[i] = -1, -1
	}

	for i := 0; i < n; i++ {
		want := nb[i]
		if equalContent(ob[i], want) {
			continue
		}
		if want.hole {
			punches = append(punches, i)
			continue
		}
		// Find a distinct old block with the wanted content.
		src := -1
		for _, j := range byContent[string(want.data)] {
			if !usedSrc[j] {
				src = j
				break
			}
		}
		if src < 0 {
			writes = append(writes, Step{Op: OpWrite, Src: -1, Dst: i, Data: append([]byte(nil), want.data...)})
			continue
		}
		usedSrc[src] = true
		m := &pmove{src: src, dst: i}
		writer[i] = len(moves)
		reader[src] = len(moves)
		moves = append(moves, m)
	}

	plan := &Plan{BlockSize: blockSize}
	unshared := make([]bool, n)
	emitWrite := func(s Step) {
		if !ob[s.Dst].hole && ob[s.Dst].shared && !unshared[s.Dst] {
			plan.Steps = append(plan.Steps, Step{Op: OpUnshare, Src: -1, Dst: s.Dst})
			unshared[s.Dst] = true
		}
		plan.Steps = append(plan.Steps, s)
	}
	emitMove := func(m *pmove) {
		if m.load {
			emitWrite(Step{Op: OpStageLoad, Src: -1, Dst: m.dst, SrcHash: m.hash})
		} else {
			emitWrite(Step{Op: OpMove, Src: m.src, Dst: m.dst, SrcHash: HashContent(ob[m.src].data)})
		}
		m.done = true
	}

	// Kahn-style emission: a move may run once no pending move still reads
	// its target. Cycles are broken by saving one block to staging and
	// deferring its consumer as a stage-load.
	stagingBusy := false
	pending := 0
	for _, m := range moves {
		if !m.done {
			pending++
		}
	}
	queue := make([]*pmove, 0, len(moves))
	emittable := func(m *pmove) bool {
		if m.done {
			return false
		}
		r := reader[m.dst]
		return r < 0 || moves[r].done
	}
	for _, m := range moves {
		if emittable(m) {
			queue = append(queue, m)
		}
	}
	for pending > 0 {
		if len(queue) == 0 {
			// Every pending move is blocked: we are inside a cycle. Save
			// the target of any pending real move to staging; the move
			// reading that block becomes a deferred stage-load.
			if stagingBusy {
				return nil, errors.New("imgdiff: internal: staging exhausted")
			}
			var m *pmove
			for _, cand := range moves {
				if !cand.done && !cand.load {
					m = cand
					break
				}
			}
			if m == nil {
				return nil, errors.New("imgdiff: internal: cycle without real move")
			}
			d := m.dst
			plan.Steps = append(plan.Steps, Step{Op: OpStageSave, Src: d, Dst: -1, SrcHash: HashContent(ob[d].data)})
			stagingBusy = true
			r := reader[d]
			if r < 0 || moves[r].done {
				return nil, errors.New("imgdiff: internal: cycle break on unread block")
			}
			moves[r].load = true
			moves[r].src = -1
			moves[r].hash = HashContent(ob[d].data)
			reader[d] = -1
			// m's target is no longer read by a pending move.
			queue = append(queue, m)
			continue
		}
		m := queue[0]
		queue = queue[1:]
		if m.done {
			continue
		}
		if !emittable(m) {
			continue // requeued stale entry; will be picked up again
		}
		emitMove(m)
		pending--
		if m.load {
			stagingBusy = false
		} else {
			// m consumed block m.src: the move writing m.src (if any)
			// may now be emittable.
			if w := writer[m.src]; w >= 0 && !moves[w].done && emittable(moves[w]) {
				queue = append(queue, moves[w])
			}
		}
		// The stage-load deferred on this cycle may have become emittable.
		for _, cand := range moves {
			if !cand.done && emittable(cand) {
				queue = append(queue, cand)
			}
		}
	}

	for _, w := range writes {
		emitWrite(w)
	}
	for _, i := range punches {
		plan.Steps = append(plan.Steps, Step{Op: OpPunch, Src: -1, Dst: i})
	}
	return plan, nil
}
