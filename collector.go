package dataeng

import (
	"errors"
	"fmt"
	"math/big"
	"sort"
	"sync"
)

// ErrInvalidVersion is returned when a batch carries a non-positive version.
var ErrInvalidVersion = errors.New("dataeng: batch version must be positive")

// ErrConflict is returned when a batch reuses an already known version with
// content that differs from the original submission.
var ErrConflict = errors.New("dataeng: conflicting re-delivery for known version")

// ErrBudgetExceeded is returned when buffering an out-of-order batch would
// make the retained pending bytes exceed the configured budget.
var ErrBudgetExceeded = errors.New("dataeng: pending batch byte budget exceeded")

// cell is one retained matrix entry together with its provenance.
type cell struct {
	value *big.Int
	src   []byte
}

// CSR is the canonical compressed sparse row representation of one version.
//
// RowPtr has Rows+1 entries; column indices and values are ordered by row and
// then by column. Explicitly stored zero values are included; deleted cells
// are absent. Sources holds the originating event ID for each value.
type CSR struct {
	Rows    int
	Cols    int
	RowPtr  []int
	Columns []int
	Values  []*big.Int
	Sources [][]byte
}

// VersionSnapshot is the committed result for one version.
type VersionSnapshot struct {
	Version int
	CSR     CSR
}

type pendingBatch struct {
	ops    map[[2]int]op
	digest [32]byte
	size   int
}

// Collector ingests versioned batches, tolerates out-of-order delivery and
// emits a canonical CSR snapshot for every committed version. It is safe for
// concurrent use.
type Collector struct {
	mu sync.Mutex

	rows   int
	cols   int
	budget int

	state    map[[2]int]cell
	expected int

	pending   map[int]pendingBatch
	pendingBy int

	committed map[int][32]byte
	snapshots map[int]*VersionSnapshot
}

// NewCollector builds a Collector. rows and cols bound the accepted event
// coordinates (events outside [0,rows) x [0,cols) fail their batch), and
// pendingBudgetBytes bounds the total retained size of buffered batches.
func NewCollector(rows, cols, pendingBudgetBytes int) (*Collector, error) {
	if rows <= 0 || cols <= 0 {
		return nil, fmt.Errorf("dataeng: matrix dimensions must be positive (rows=%d cols=%d)", rows, cols)
	}
	if pendingBudgetBytes <= 0 {
		return nil, fmt.Errorf("dataeng: pending byte budget must be positive (got %d)", pendingBudgetBytes)
	}
	return &Collector{
		rows:      rows,
		cols:      cols,
		budget:    pendingBudgetBytes,
		state:     make(map[[2]int]cell),
		expected:  1,
		pending:   make(map[int]pendingBatch),
		committed: make(map[int][32]byte),
		snapshots: make(map[int]*VersionSnapshot),
	}, nil
}

// Submit applies one batch.
//
// An already committed version is accepted only when the batch is identical to
// the original submission; its stored snapshot is returned. A new batch whose
// predecessor is missing is buffered and an empty slice is returned. When the
// submission closes a gap, every now-contiguous version is committed and its
// snapshot returned in ascending version order.
func (c *Collector) Submit(batch Batch) ([]*VersionSnapshot, error) {
	if batch.Version <= 0 {
		return nil, ErrInvalidVersion
	}

	ops, digest, err := batch.reduce(c.rows, c.cols)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if known, ok := c.committed[batch.Version]; ok {
		if known != digest {
			return nil, fmt.Errorf("%w: version %d", ErrConflict, batch.Version)
		}
		return []*VersionSnapshot{c.snapshots[batch.Version]}, nil
	}

	if queued, ok := c.pending[batch.Version]; ok {
		if queued.digest != digest {
			return nil, fmt.Errorf("%w: version %d", ErrConflict, batch.Version)
		}
		return nil, nil
	}

	size := batch.ByteSize()
	if batch.Version != c.expected && c.pendingBy+size > c.budget {
		return nil, fmt.Errorf("%w: version %d needs %d bytes, %d of %d budget in use",
			ErrBudgetExceeded, batch.Version, size, c.pendingBy, c.budget)
	}

	c.pending[batch.Version] = pendingBatch{ops: ops, digest: digest, size: size}
	c.pendingBy += size

	var committed []*VersionSnapshot
	for {
		next, ok := c.pending[c.expected]
		if !ok {
			break
		}
		delete(c.pending, c.expected)
		c.pendingBy -= next.size
		c.apply(next.ops)
		snapshot := &VersionSnapshot{
			Version: c.expected,
			CSR:     c.buildCSR(),
		}
		c.committed[c.expected] = next.digest
		c.snapshots[c.expected] = snapshot
		committed = append(committed, snapshot)
		c.expected++
	}
	return committed, nil
}

func (c *Collector) apply(ops map[[2]int]op) {
	for coordinate, operation := range ops {
		if operation.delete {
			delete(c.state, coordinate)
			continue
		}
		c.state[coordinate] = cell{
			value: new(big.Int).Set(operation.value),
			src:   append([]byte(nil), operation.id...),
		}
	}
}

func (c *Collector) buildCSR() CSR {
	coordinates := make([][2]int, 0, len(c.state))
	for coordinate := range c.state {
		coordinates = append(coordinates, coordinate)
	}
	sort.Slice(coordinates, func(i, j int) bool {
		if coordinates[i][0] != coordinates[j][0] {
			return coordinates[i][0] < coordinates[j][0]
		}
		return coordinates[i][1] < coordinates[j][1]
	})

	csr := CSR{
		Rows:    c.rows,
		Cols:    c.cols,
		RowPtr:  make([]int, c.rows+1),
		Columns: make([]int, 0, len(coordinates)),
		Values:  make([]*big.Int, 0, len(coordinates)),
		Sources: make([][]byte, 0, len(coordinates)),
	}

	for _, coordinate := range coordinates {
		entry := c.state[coordinate]
		csr.Columns = append(csr.Columns, coordinate[1])
		csr.Values = append(csr.Values, new(big.Int).Set(entry.value))
		csr.Sources = append(csr.Sources, append([]byte(nil), entry.src...))
	}

	entry := 0
	for row := 0; row < c.rows; row++ {
		for entry < len(coordinates) && coordinates[entry][0] == row {
			entry++
		}
		csr.RowPtr[row+1] = entry
	}
	return csr
}

// NextVersion reports the smallest version that has not been committed yet.
func (c *Collector) NextVersion() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.expected
}

// PendingBytes reports the retained size of batches buffered behind a gap.
func (c *Collector) PendingBytes() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pendingBy
}

// Snapshot returns the committed snapshot for version, or nil if the version
// has not been committed yet.
func (c *Collector) Snapshot(version int) *VersionSnapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.snapshots[version]
}
