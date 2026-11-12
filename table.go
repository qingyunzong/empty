package dataeng

import (
	"crypto/sha256"
	"fmt"
	"math/big"
)

// Direction is the sign of a key in a recovered set difference.
//
// DirectionPositive means the identifier occurs only in A. DirectionNegative
// means the identifier occurs only in B.
type Direction int8

const (
	DirectionPositive Direction = 1
	DirectionNegative Direction = -1
)

func (d Direction) String() string {
	switch d {
	case DirectionPositive:
		return "+1"
	case DirectionNegative:
		return "-1"
	default:
		return fmt.Sprintf("%d", int8(d))
	}
}

type tableCell struct {
	count    *big.Int
	keyXor   uint64
	checkXor uint64
}

// Table is a fixed-cell IBLT summary. Its cells are not exported because
// their signed counts are arbitrary precision integers. CellView values are
// safe snapshots for inspection.
type Table struct {
	cfg   Config
	cells []tableCell
}

// CellView is a detached view of one table cell. Count is a copy and may be
// modified by the caller without changing the table.
type CellView struct {
	Index    int
	Count    *big.Int
	KeyXor   uint64
	CheckXor uint64
}

// CountString returns Count in decimal, including its sign.
func (v CellView) CountString() string {
	if v.Count == nil {
		return "0"
	}
	return v.Count.String()
}

func (v CellView) isZero() bool {
	return (v.Count == nil || v.Count.Sign() == 0) && v.KeyXor == 0 && v.CheckXor == 0
}

// NewTable creates an empty table with the supplied configuration.
func NewTable(cfg Config) (*Table, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	cfg = cloneConfig(cfg)
	cells := make([]tableCell, cfg.Cells)
	for i := range cells {
		cells[i].count = new(big.Int)
	}
	return &Table{cfg: cfg, cells: cells}, nil
}

// BuildTable creates a table from a complete set snapshot. The snapshot must
// not contain duplicate IDs. If any host hash output is invalid, no partial
// table is returned.
func BuildTable(cfg Config, ids []uint64) (*Table, error) {
	table, err := NewTable(cfg)
	if err != nil {
		return nil, err
	}
	seen := make(map[uint64]struct{}, len(ids))
	for _, id := range ids {
		if _, ok := seen[id]; ok {
			return nil, fmt.Errorf("%w: %d", ErrDuplicateID, id)
		}
		seen[id] = struct{}{}
		if err := table.Insert(id); err != nil {
			return nil, err
		}
	}
	return table, nil
}

// Config returns a copy of the table configuration.
func (t *Table) Config() Config {
	if t == nil {
		return Config{}
	}
	return cloneConfig(t.cfg)
}

// ConfigFingerprint returns the identifying configuration fingerprint.
func (t *Table) ConfigFingerprint() [32]byte {
	if t == nil {
		return [32]byte{}
	}
	return fingerprintConfig(t.cfg)
}

// Cells returns detached views of every cell in index order.
func (t *Table) Cells() []CellView {
	if t == nil {
		return nil
	}
	out := make([]CellView, len(t.cells))
	for i := range t.cells {
		out[i] = t.cellView(i)
	}
	return out
}

// NonZeroCells returns detached views of cells whose count or XOR fields are
// non-zero. A cell with count zero but a non-zero XOR is residual, not empty.
func (t *Table) NonZeroCells() []CellView {
	if t == nil {
		return nil
	}
	out := make([]CellView, 0, len(t.cells))
	for i := range t.cells {
		view := t.cellView(i)
		if !view.isZero() {
			out = append(out, view)
		}
	}
	return out
}

func (t *Table) cellView(index int) CellView {
	return CellView{
		Index:    index,
		Count:    new(big.Int).Set(t.cells[index].count),
		KeyXor:   t.cells[index].keyXor,
		CheckXor: t.cells[index].checkXor,
	}
}

// Insert adds one identifier to the summary. The host mapping is validated
// completely before any cell is changed.
func (t *Table) Insert(id uint64) error {
	return t.modify(id, 1)
}

// Delete removes one identifier from the summary. Counts may become negative.
// The host mapping is validated completely before any cell is changed.
func (t *Table) Delete(id uint64) error {
	return t.modify(id, -1)
}

func (t *Table) modify(id uint64, delta int64) error {
	if t == nil {
		return fmt.Errorf("%w: nil table", ErrInternalState)
	}
	indices, check, err := t.cfg.mapID(id)
	if err != nil {
		return err
	}
	step := big.NewInt(delta)
	for _, index := range indices {
		cell := &t.cells[index]
		cell.count.Add(cell.count, step)
		cell.keyXor ^= id
		cell.checkXor ^= check
	}
	return nil
}

// Subtract returns A-B as a new table. The two summaries must have identical
// configurations. Counts are subtracted and the key and check accumulators
// are XORed independently.
func Subtract(a, b *Table) (*Table, error) {
	if a == nil || b == nil {
		return nil, fmt.Errorf("%w: nil table", ErrInternalState)
	}
	if !a.cfg.sameIdentity(b.cfg) {
		return nil, ErrConfigMismatch
	}
	if len(a.cells) != len(b.cells) {
		return nil, fmt.Errorf("%w: cell count mismatch", ErrInternalState)
	}

	out := &Table{cfg: cloneConfig(a.cfg), cells: make([]tableCell, len(a.cells))}
	for i := range out.cells {
		out.cells[i].count = new(big.Int).Sub(a.cells[i].count, b.cells[i].count)
		out.cells[i].keyXor = a.cells[i].keyXor ^ b.cells[i].keyXor
		out.cells[i].checkXor = a.cells[i].checkXor ^ b.cells[i].checkXor
	}
	return out, nil
}

// Fingerprint returns a stable SHA-256 fingerprint of the configuration and
// all cells.
func (t *Table) Fingerprint() [32]byte {
	if t == nil {
		return [32]byte{}
	}
	h := sha256.New()
	writeBytes(h, []byte("dataeng-iblt-table/v1"))
	configFP := fingerprintConfig(t.cfg)
	_, _ = h.Write(configFP[:])
	for i := range t.cells {
		writeUint64(h, uint64(i))
		writeBytes(h, []byte(t.cells[i].count.Text(10)))
		writeUint64(h, t.cells[i].keyXor)
		writeUint64(h, t.cells[i].checkXor)
	}
	return sum32(h)
}

func (t *Table) allZero() bool {
	for i := range t.cells {
		if t.cells[i].count.Sign() != 0 || t.cells[i].keyXor != 0 || t.cells[i].checkXor != 0 {
			return false
		}
	}
	return true
}
