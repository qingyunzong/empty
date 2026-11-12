package dataeng

import (
	"container/heap"
	"crypto/sha256"
	"fmt"
	"math/big"
)

var (
	bigOne      = big.NewInt(1)
	bigMinusOne = big.NewInt(-1)
)

// PeelStatus is the terminal or paused condition of a peel operation.
type PeelStatus string

const (
	// PeelStatusPeeled means every cell's count, key XOR, and check XOR is
	// zero. It means the digest is fully peeled, not that A and B are equal.
	PeelStatusPeeled PeelStatus = "peeled"

	// PeelStatusIncomplete means a non-zero cell remains but no candidate
	// exists. Residual cells are returned; no specific missing key may be
	// inferred from them.
	PeelStatusIncomplete PeelStatus = "incomplete"

	// PeelStatusPaused means the successful-step budget ran out while at least
	// one candidate remained. State is bound to the original difference table
	// and its configuration fingerprint.
	PeelStatusPaused PeelStatus = "paused"

	// PeelStatusContradiction means an already-emitted key appeared again in
	// either direction. The candidate was not consumed and residual cells
	// remain for inspection.
	PeelStatusContradiction PeelStatus = "contradiction"
)

// PeeledKey is one successfully eliminated candidate.
type PeeledKey struct {
	Key       uint64
	Direction Direction
	Cell      int
	Step      int
}

// Conflict describes a repeated key that stopped peeling.
type Conflict struct {
	Key               uint64
	Direction         Direction
	Cell              int
	PreviousDirection Direction
	PreviousStep      int
}

// PeelResult is a snapshot of the peel operation. Keys is cumulative across
// resumes; NewKeys contains only keys emitted by the current Peel or ResumePeel
// call. A streaming host should append NewKeys, while verification uses the
// cumulative Keys. State is non-nil only for PeelStatusPaused.
type PeelResult struct {
	Status            PeelStatus
	Keys              []PeeledKey
	NewKeys           []PeeledKey
	Steps             int
	StepsThisRun      int
	Residual          []CellView
	Conflict          *Conflict
	ConfigFingerprint [32]byte
	DiffFingerprint   [32]byte
	State             *PeelState
}

// PeelState is an opaque, internally consistent paused peel state. Resume it
// with ResumePeel. A state can be resumed repeatedly; resumption clones it and
// does not mutate the paused value.
type PeelState struct {
	cfg       Config
	configFP  [32]byte
	diffFP    [32]byte
	cells     []peelCell
	pending   candidateHeap
	emitted   []PeeledKey
	seen      map[uint64]PeeledKey
	steps     int
	checksum  [32]byte
	finalized bool
}

type peelCell struct {
	cell    tableCell
	version uint64
}

type candidateInfo struct {
	key       uint64
	direction Direction
	indices   []int
	check     uint64
}

type candidateItem struct {
	index     int
	version   uint64
	key       uint64
	direction Direction
}

type candidateHeap []candidateItem

func (h candidateHeap) Len() int { return len(h) }

func (h candidateHeap) Less(i, j int) bool {
	if h[i].index != h[j].index {
		return h[i].index < h[j].index
	}
	if h[i].version != h[j].version {
		return h[i].version < h[j].version
	}
	if h[i].key != h[j].key {
		return h[i].key < h[j].key
	}
	return h[i].direction < h[j].direction
}

func (h candidateHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }

func (h *candidateHeap) Push(value any) {
	*h = append(*h, value.(candidateItem))
}

func (h *candidateHeap) Pop() any {
	old := *h
	last := len(old) - 1
	item := old[last]
	*h = old[:last]
	return item
}

// Steps returns the cumulative number of successfully eliminated keys.
func (s *PeelState) Steps() int {
	if s == nil {
		return 0
	}
	return s.steps
}

// ConfigFingerprint returns the configuration binding of the paused state.
func (s *PeelState) ConfigFingerprint() [32]byte {
	if s == nil {
		return [32]byte{}
	}
	return s.configFP
}

// DiffFingerprint returns the original difference-table binding of the
// paused state.
func (s *PeelState) DiffFingerprint() [32]byte {
	if s == nil {
		return [32]byte{}
	}
	return s.diffFP
}

// Fingerprint returns the consistency checksum of the paused state.
func (s *PeelState) Fingerprint() [32]byte {
	if s == nil {
		return [32]byte{}
	}
	return s.checksum
}

// Peel runs the peeling procedure on a working copy of diff. It performs at
// most maxSteps successful candidate eliminations. Candidate inspection,
// stale-queue rejection, and contradiction checks do not consume budget.
//
// The original diff table is never changed.
func Peel(diff *Table, maxSteps int) (*PeelResult, error) {
	if maxSteps <= 0 {
		return nil, fmt.Errorf("%w: got %d", ErrInvalidBudget, maxSteps)
	}
	state, err := newPeelState(diff)
	if err != nil {
		return nil, err
	}
	return state.advance(maxSteps)
}

// PeelAll runs peeling with no practical step limit.
func PeelAll(diff *Table) (*PeelResult, error) {
	return Peel(diff, int(^uint(0)>>1))
}

// ResumePeel continues a paused peel operation. It verifies that the paused
// state is internally consistent, that its configuration fingerprint matches
// diff, and that its original difference fingerprint matches diff. The
// supplied state is not mutated.
func ResumePeel(diff *Table, state *PeelState, maxSteps int) (*PeelResult, error) {
	if maxSteps <= 0 {
		return nil, fmt.Errorf("%w: got %d", ErrInvalidBudget, maxSteps)
	}
	if diff == nil {
		return nil, fmt.Errorf("%w: nil difference table", ErrInternalState)
	}
	if state == nil {
		return nil, fmt.Errorf("%w: nil paused state", ErrResumeMismatch)
	}
	if err := state.validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrResumeMismatch, err)
	}
	if state.configFP != diff.ConfigFingerprint() || !state.cfg.sameIdentity(diff.cfg) {
		return nil, fmt.Errorf("%w: configuration fingerprint does not match the difference table", ErrResumeMismatch)
	}
	if state.diffFP != diff.Fingerprint() {
		return nil, fmt.Errorf("%w: original difference fingerprint does not match the supplied table", ErrResumeMismatch)
	}
	return state.clone().advance(maxSteps)
}

func newPeelState(diff *Table) (*PeelState, error) {
	if diff == nil {
		return nil, fmt.Errorf("%w: nil difference table", ErrInternalState)
	}
	if len(diff.cells) != diff.cfg.Cells {
		return nil, fmt.Errorf("%w: table has %d cells for configuration of %d",
			ErrInternalState, len(diff.cells), diff.cfg.Cells)
	}
	state := &PeelState{
		cfg:      cloneConfig(diff.cfg),
		configFP: fingerprintConfig(diff.cfg),
		pending:  make(candidateHeap, 0, len(diff.cells)),
		seen:     make(map[uint64]PeeledKey),
	}
	state.diffFP = diff.Fingerprint()
	state.cells = make([]peelCell, len(diff.cells))
	for i := range diff.cells {
		state.cells[i].cell = tableCell{
			count:    new(big.Int).Set(diff.cells[i].count),
			keyXor:   diff.cells[i].keyXor,
			checkXor: diff.cells[i].checkXor,
		}
	}
	for i := range state.cells {
		if err := state.enqueueIfCandidate(i); err != nil {
			return nil, err
		}
	}
	return state, nil
}

func (s *PeelState) advance(maxSteps int) (*PeelResult, error) {
	stepsThisRun := 0
	startEmitted := len(s.emitted)
	for {
		if s.allCellsZero() {
			return s.result(PeelStatusPeeled, stepsThisRun, nil, startEmitted), nil
		}

		item, info, ok, err := s.peekCandidate()
		if err != nil {
			return nil, err
		}
		if !ok {
			return s.result(PeelStatusIncomplete, stepsThisRun, nil, startEmitted), nil
		}
		if stepsThisRun >= maxSteps {
			return s.pausedResult(stepsThisRun, startEmitted), nil
		}

		if previous, repeated := s.seen[info.key]; repeated {
			conflict := &Conflict{
				Key:               info.key,
				Direction:         info.direction,
				Cell:              item.index,
				PreviousDirection: previous.Direction,
				PreviousStep:      previous.Step,
			}
			return s.result(PeelStatusContradiction, stepsThisRun, conflict, startEmitted), nil
		}

		heap.Pop(&s.pending)
		if err := s.applyCandidate(info); err != nil {
			return nil, err
		}
		s.steps++
		record := PeeledKey{
			Key:       info.key,
			Direction: info.direction,
			Cell:      item.index,
			Step:      s.steps,
		}
		s.emitted = append(s.emitted, record)
		s.seen[info.key] = record
		stepsThisRun++
	}
}

func (s *PeelState) applyCandidate(info candidateInfo) error {
	delta := big.NewInt(int64(info.direction))
	for _, index := range info.indices {
		cell := &s.cells[index]
		cell.cell.count.Sub(cell.cell.count, delta)
		cell.cell.keyXor ^= info.key
		cell.cell.checkXor ^= info.check
		cell.version++
	}
	for _, index := range info.indices {
		if err := s.enqueueIfCandidate(index); err != nil {
			return err
		}
	}
	return nil
}

func (s *PeelState) enqueueIfCandidate(index int) error {
	info, ok, err := s.inspectCell(index)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	heap.Push(&s.pending, candidateItem{
		index:     index,
		version:   s.cells[index].version,
		key:       info.key,
		direction: info.direction,
	})
	return nil
}

func (s *PeelState) inspectCell(index int) (candidateInfo, bool, error) {
	if index < 0 || index >= len(s.cells) {
		return candidateInfo{}, false, fmt.Errorf("%w: cell index %d", ErrInternalState, index)
	}
	cell := &s.cells[index].cell
	if cell.count.Cmp(bigOne) != 0 && cell.count.Cmp(bigMinusOne) != 0 {
		return candidateInfo{}, false, nil
	}

	key := cell.keyXor
	indices, check, err := s.cfg.mapID(key)
	if err != nil {
		return candidateInfo{}, false, err
	}
	if check != cell.checkXor {
		return candidateInfo{}, false, nil
	}

	found := false
	for _, mapped := range indices {
		if mapped == index {
			found = true
			break
		}
	}
	if !found {
		return candidateInfo{}, false, nil
	}

	direction := DirectionPositive
	if cell.count.Sign() < 0 {
		direction = DirectionNegative
	}
	return candidateInfo{
		key:       key,
		direction: direction,
		indices:   indices,
		check:     check,
	}, true, nil
}

func (s *PeelState) peekCandidate() (candidateItem, candidateInfo, bool, error) {
	for len(s.pending) > 0 {
		item := s.pending[0]
		if item.index < 0 || item.index >= len(s.cells) {
			return candidateItem{}, candidateInfo{}, false,
				fmt.Errorf("%w: queued cell index %d", ErrInternalState, item.index)
		}

		current := &s.cells[item.index]
		if item.version != current.version {
			heap.Pop(&s.pending)
			continue
		}

		info, ok, err := s.inspectCell(item.index)
		if err != nil {
			return candidateItem{}, candidateInfo{}, false, err
		}
		if !ok || info.key != item.key || info.direction != item.direction {
			heap.Pop(&s.pending)
			continue
		}
		return item, info, true, nil
	}
	return candidateItem{}, candidateInfo{}, false, nil
}

func (s *PeelState) allCellsZero() bool {
	for i := range s.cells {
		cell := &s.cells[i].cell
		if cell.count.Sign() != 0 || cell.keyXor != 0 || cell.checkXor != 0 {
			return false
		}
	}
	return true
}

func (s *PeelState) result(status PeelStatus, stepsThisRun int, conflict *Conflict, startEmitted int) *PeelResult {
	return &PeelResult{
		Status:            status,
		Keys:              append([]PeeledKey(nil), s.emitted...),
		NewKeys:           append([]PeeledKey(nil), s.emitted[startEmitted:]...),
		Steps:             s.steps,
		StepsThisRun:      stepsThisRun,
		Residual:          s.nonZeroCells(),
		Conflict:          conflict,
		ConfigFingerprint: s.configFP,
		DiffFingerprint:   s.diffFP,
	}
}

func (s *PeelState) pausedResult(stepsThisRun, startEmitted int) *PeelResult {
	result := s.result(PeelStatusPaused, stepsThisRun, nil, startEmitted)
	result.State = s.snapshot()
	return result
}

func (s *PeelState) nonZeroCells() []CellView {
	out := make([]CellView, 0, len(s.cells))
	for i := range s.cells {
		cell := &s.cells[i].cell
		view := CellView{
			Index:    i,
			Count:    new(big.Int).Set(cell.count),
			KeyXor:   cell.keyXor,
			CheckXor: cell.checkXor,
		}
		if !view.isZero() {
			out = append(out, view)
		}
	}
	return out
}

func (s *PeelState) snapshot() *PeelState {
	out := s.clone()
	out.checksum = out.computeChecksum()
	out.finalized = true
	return out
}

func (s *PeelState) clone() *PeelState {
	if s == nil {
		return nil
	}
	out := &PeelState{
		cfg:       cloneConfig(s.cfg),
		configFP:  s.configFP,
		diffFP:    s.diffFP,
		cells:     make([]peelCell, len(s.cells)),
		pending:   append(candidateHeap(nil), s.pending...),
		emitted:   append([]PeeledKey(nil), s.emitted...),
		seen:      make(map[uint64]PeeledKey, len(s.seen)),
		steps:     s.steps,
		checksum:  s.checksum,
		finalized: s.finalized,
	}
	for i := range s.cells {
		out.cells[i] = peelCell{
			cell: tableCell{
				count:    new(big.Int).Set(s.cells[i].cell.count),
				keyXor:   s.cells[i].cell.keyXor,
				checkXor: s.cells[i].cell.checkXor,
			},
			version: s.cells[i].version,
		}
	}
	for key, record := range s.seen {
		out.seen[key] = record
	}
	return out
}

func (s *PeelState) computeChecksum() [32]byte {
	h := sha256.New()
	writeBytes(h, []byte("dataeng-peel-state/v1"))
	_, _ = h.Write(s.configFP[:])
	_, _ = h.Write(s.diffFP[:])
	writeUint64(h, uint64(s.steps))

	writeUint64(h, uint64(len(s.cells)))
	for i := range s.cells {
		cell := &s.cells[i]
		writeBytes(h, []byte(cell.cell.count.Text(10)))
		writeUint64(h, cell.cell.keyXor)
		writeUint64(h, cell.cell.checkXor)
		writeUint64(h, cell.version)
	}

	writeUint64(h, uint64(len(s.emitted)))
	for _, record := range s.emitted {
		writeUint64(h, record.Key)
		writeUint64(h, uint64(int8(record.Direction)))
		writeUint64(h, uint64(record.Cell))
		writeUint64(h, uint64(record.Step))
	}

	writeUint64(h, uint64(len(s.pending)))
	for _, item := range s.pending {
		writeUint64(h, uint64(item.index))
		writeUint64(h, item.version)
		writeUint64(h, item.key)
		writeUint64(h, uint64(int8(item.direction)))
	}
	return sum32(h)
}

func (s *PeelState) validate() error {
	if s == nil {
		return fmt.Errorf("nil state")
	}
	if !s.finalized || s.checksum != s.computeChecksum() {
		return fmt.Errorf("state checksum mismatch")
	}
	if err := s.cfg.Validate(); err != nil {
		return err
	}
	if len(s.cells) != s.cfg.Cells {
		return fmt.Errorf("state has %d cells for configuration of %d", len(s.cells), s.cfg.Cells)
	}
	if s.configFP != fingerprintConfig(s.cfg) {
		return fmt.Errorf("configuration fingerprint mismatch")
	}
	if s.steps != len(s.emitted) {
		return fmt.Errorf("step count %d differs from emitted key count %d", s.steps, len(s.emitted))
	}
	if len(s.seen) != len(s.emitted) {
		return fmt.Errorf("output map size %d differs from emitted key count %d", len(s.seen), len(s.emitted))
	}

	for i := range s.cells {
		if s.cells[i].cell.count == nil {
			return fmt.Errorf("cell %d has a nil count", i)
		}
	}
	for i, record := range s.emitted {
		if record.Direction != DirectionPositive && record.Direction != DirectionNegative {
			return fmt.Errorf("emitted key %d has invalid direction %d", record.Key, record.Direction)
		}
		if record.Cell < 0 || record.Cell >= len(s.cells) {
			return fmt.Errorf("emitted key %d has invalid source cell %d", record.Key, record.Cell)
		}
		if record.Step != i+1 {
			return fmt.Errorf("emitted key %d has step %d, want %d", record.Key, record.Step, i+1)
		}
		previous, ok := s.seen[record.Key]
		if !ok || previous != record {
			return fmt.Errorf("output map entry for key %d is inconsistent", record.Key)
		}
	}
	for _, item := range s.pending {
		if item.index < 0 || item.index >= len(s.cells) {
			return fmt.Errorf("queued candidate has invalid cell %d", item.index)
		}
		if item.version > s.cells[item.index].version {
			return fmt.Errorf("queued candidate at cell %d is newer than the cell", item.index)
		}
		if item.direction != DirectionPositive && item.direction != DirectionNegative {
			return fmt.Errorf("queued candidate at cell %d has invalid direction %d", item.index, item.direction)
		}
	}
	return nil
}
