// Package matrixlib maintains integer sparse matrices A and B and their
// product C = A*B, updated incrementally after single-element corrections.
package matrixlib

import (
	"errors"
	"fmt"
	"math"
	"math/bits"
	"sort"
)

// ErrOverflow is returned when an int64 multiplication or addition would
// overflow while computing a matrix product.
var ErrOverflow = errors.New("matrixlib: integer overflow")

// ErrOutOfRange is returned for indices outside the matrix dimensions.
var ErrOutOfRange = errors.New("matrixlib: index out of range")

// Entry is a single non-zero element of a sparse matrix.
type Entry struct {
	Row, Col int
	Val      int64
}

// Matrix is a sparse integer matrix. Zero-valued elements are never stored:
// setting an element to zero deletes it.
type Matrix struct {
	rows, cols int
	data       map[[2]int]int64
	byRow      map[int]map[int]int64 // row -> col -> val
	byCol      map[int]map[int]int64 // col -> row -> val
}

// NewMatrix creates an empty rows x cols sparse matrix.
func NewMatrix(rows, cols int) *Matrix {
	if rows < 0 || cols < 0 {
		panic("matrixlib: negative dimensions")
	}
	return &Matrix{
		rows:  rows,
		cols:  cols,
		data:  make(map[[2]int]int64),
		byRow: make(map[int]map[int]int64),
		byCol: make(map[int]map[int]int64),
	}
}

// Dims returns the matrix dimensions.
func (m *Matrix) Dims() (rows, cols int) { return m.rows, m.cols }

// Get returns the element at (r, c); absent elements are zero.
func (m *Matrix) Get(r, c int) int64 {
	if r < 0 || r >= m.rows || c < 0 || c >= m.cols {
		return 0
	}
	return m.data[[2]int{r, c}]
}

// Set assigns v to element (r, c). A zero value deletes the stored entry.
func (m *Matrix) Set(r, c int, v int64) error {
	if r < 0 || r >= m.rows || c < 0 || c >= m.cols {
		return fmt.Errorf("%w: (%d, %d) not in %dx%d", ErrOutOfRange, r, c, m.rows, m.cols)
	}
	key := [2]int{r, c}
	if _, ok := m.data[key]; ok {
		delete(m.byRow[r], c)
		delete(m.byCol[c], r)
		if len(m.byRow[r]) == 0 {
			delete(m.byRow, r)
		}
		if len(m.byCol[c]) == 0 {
			delete(m.byCol, c)
		}
	}
	if v == 0 {
		delete(m.data, key)
		return nil
	}
	m.data[key] = v
	if m.byRow[r] == nil {
		m.byRow[r] = make(map[int]int64)
	}
	m.byRow[r][c] = v
	if m.byCol[c] == nil {
		m.byCol[c] = make(map[int]int64)
	}
	m.byCol[c][r] = v
	return nil
}

// RowEntries returns the non-zero entries of row r, sorted by column.
func (m *Matrix) RowEntries(r int) []Entry {
	row := m.byRow[r]
	out := make([]Entry, 0, len(row))
	for c, v := range row {
		out = append(out, Entry{Row: r, Col: c, Val: v})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Col < out[j].Col })
	return out
}

// ColEntries returns the non-zero entries of column c, sorted by row.
func (m *Matrix) ColEntries(c int) []Entry {
	col := m.byCol[c]
	out := make([]Entry, 0, len(col))
	for r, v := range col {
		out = append(out, Entry{Row: r, Col: c, Val: v})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Row < out[j].Row })
	return out
}

// Entries returns all non-zero entries in row-major order.
func (m *Matrix) Entries() []Entry {
	out := make([]Entry, 0, len(m.data))
	for k, v := range m.data {
		out = append(out, Entry{Row: k[0], Col: k[1], Val: v})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Row != out[j].Row {
			return out[i].Row < out[j].Row
		}
		return out[i].Col < out[j].Col
	})
	return out
}

// Clone returns a deep copy; the copy is unaffected by later mutations.
func (m *Matrix) Clone() *Matrix {
	cp := NewMatrix(m.rows, m.cols)
	for k, v := range m.data {
		cp.data[k] = v
	}
	for r, row := range m.byRow {
		nr := make(map[int]int64, len(row))
		for c, v := range row {
			nr[c] = v
		}
		cp.byRow[r] = nr
	}
	for c, col := range m.byCol {
		nc := make(map[int]int64, len(col))
		for r, v := range col {
			nc[r] = v
		}
		cp.byCol[c] = nc
	}
	return cp
}

// Equal reports whether both matrices have identical dimensions and entries.
func (m *Matrix) Equal(o *Matrix) bool {
	if m.rows != o.rows || m.cols != o.cols || len(m.data) != len(o.data) {
		return false
	}
	for k, v := range m.data {
		if o.data[k] != v {
			return false
		}
	}
	return true
}

// addChecked returns a+b and whether it overflows int64.
func addChecked(a, b int64) (int64, bool) {
	s, _ := bits.Add64(uint64(a), uint64(b), 0)
	sum := int64(s)
	// Overflow iff signs of a and b are equal and differ from sign of sum.
	if (a >= 0) == (b >= 0) && (sum >= 0) != (a >= 0) {
		return 0, true
	}
	return sum, false
}

// mulChecked returns a*b and whether it overflows int64.
func mulChecked(a, b int64) (int64, bool) {
	ua := absU64(a)
	ub := absU64(b)
	hi, lo := bits.Mul64(ua, ub)
	if hi != 0 {
		return 0, true
	}
	neg := (a < 0) != (b < 0)
	if !neg {
		if lo > math.MaxInt64 {
			return 0, true
		}
		return int64(lo), false
	}
	if lo > 1<<63 { // magnitude exceeds |math.MinInt64|
		return 0, true
	}
	if lo == 1<<63 {
		return math.MinInt64, false
	}
	return -int64(lo), false
}

// absU64 returns |v| as a uint64; correct even for math.MinInt64.
func absU64(v int64) uint64 {
	if v < 0 {
		return uint64(-(v + 1)) + 1
	}
	return uint64(v)
}
