// Package matrix implements integer sparse matrices with overflow-checked
// arithmetic, incremental product maintenance, snapshots, diff and undo.
package matrix

import (
	"errors"
	"fmt"
	"math"
	"sort"
)

// ErrOverflow is returned when an int64 addition, subtraction or
// multiplication would overflow.
var ErrOverflow = errors.New("matrix: integer overflow")

// Key identifies one cell of a matrix.
type Key struct {
	R, C int
}

// Matrix is a sparse matrix of int64 values. Only non-zero entries are
// stored; setting an entry to zero deletes it.
type Matrix struct {
	Rows int
	Cols int
	Data map[Key]int64
}

// New returns an empty rows x cols sparse matrix.
func New(rows, cols int) *Matrix {
	if rows < 0 || cols < 0 {
		panic("matrix: negative dimension")
	}
	return &Matrix{Rows: rows, Cols: cols, Data: make(map[Key]int64)}
}

func (m *Matrix) inBounds(r, c int) bool {
	return r >= 0 && r < m.Rows && c >= 0 && c < m.Cols
}

// Get returns the value at (r, c); absent entries are zero.
func (m *Matrix) Get(r, c int) int64 {
	return m.Data[Key{r, c}]
}

// Set assigns v to (r, c). A zero value removes the entry.
func (m *Matrix) Set(r, c int, v int64) error {
	if !m.inBounds(r, c) {
		return fmt.Errorf("matrix: index (%d,%d) out of bounds %dx%d", r, c, m.Rows, m.Cols)
	}
	k := Key{r, c}
	if v == 0 {
		delete(m.Data, k)
	} else {
		m.Data[k] = v
	}
	return nil
}

// Clone returns a deep copy; mutating the copy never affects the original.
func (m *Matrix) Clone() *Matrix {
	out := New(m.Rows, m.Cols)
	for k, v := range m.Data {
		out.Data[k] = v
	}
	return out
}

// NNZ returns the number of stored (non-zero) entries.
func (m *Matrix) NNZ() int { return len(m.Data) }

// Row returns the non-zero entries of row r as col->value.
func (m *Matrix) Row(r int) map[int]int64 {
	out := make(map[int]int64)
	for k, v := range m.Data {
		if k.R == r {
			out[k.C] = v
		}
	}
	return out
}

// Col returns the non-zero entries of column c as row->value.
func (m *Matrix) Col(c int) map[int]int64 {
	out := make(map[int]int64)
	for k, v := range m.Data {
		if k.C == c {
			out[k.R] = v
		}
	}
	return out
}

// Equal reports whether two matrices have identical dimensions and entries.
func (m *Matrix) Equal(o *Matrix) bool {
	if m.Rows != o.Rows || m.Cols != o.Cols || len(m.Data) != len(o.Data) {
		return false
	}
	for k, v := range m.Data {
		if o.Data[k] != v {
			return false
		}
	}
	return true
}

// checkedAdd returns a+b or ErrOverflow.
func checkedAdd(a, b int64) (int64, error) {
	r := a + b
	if (r > a) != (b > 0) {
		return 0, ErrOverflow
	}
	return r, nil
}

// checkedSub returns a-b or ErrOverflow.
func checkedSub(a, b int64) (int64, error) {
	if b == math.MinInt64 {
		if a >= 0 {
			return 0, ErrOverflow
		}
		r, _ := checkedAdd(a, math.MaxInt64) // a<0, cannot overflow
		return checkedAdd(r, 1)
	}
	return checkedAdd(a, -b)
}

// checkedMul returns a*b or ErrOverflow.
func checkedMul(a, b int64) (int64, error) {
	if a == 0 || b == 0 {
		return 0, nil
	}
	if (a == math.MinInt64 && b == -1) || (b == math.MinInt64 && a == -1) {
		return 0, ErrOverflow
	}
	r := a * b
	if r/b != a {
		return 0, ErrOverflow
	}
	return r, nil
}

// Multiply computes a*b (a is m x k, b is k x n) using sparse row/column
// scans with overflow-checked accumulation.
func Multiply(a, b *Matrix) (*Matrix, error) {
	if a.Cols != b.Rows {
		return nil, fmt.Errorf("matrix: dimension mismatch %dx%d times %dx%d", a.Rows, a.Cols, b.Rows, b.Cols)
	}
	out := New(a.Rows, b.Cols)
	// Group a's entries by row, b's entries by row (inner index).
	aRows := make(map[int][]Key)
	for k := range a.Data {
		aRows[k.R] = append(aRows[k.R], k)
	}
	bRows := make(map[int][]Key)
	for k := range b.Data {
		bRows[k.R] = append(bRows[k.R], k)
	}
	for i, aks := range aRows {
		acc := make(map[int]int64)
		for _, ak := range aks {
			av := a.Data[ak]
			for _, bk := range bRows[ak.C] {
				prod, err := checkedMul(av, b.Data[bk])
				if err != nil {
					return nil, fmt.Errorf("matrix: C[%d][%d]: %w", i, bk.C, err)
				}
				sum, err := checkedAdd(acc[bk.C], prod)
				if err != nil {
					return nil, fmt.Errorf("matrix: C[%d][%d]: %w", i, bk.C, err)
				}
				acc[bk.C] = sum
			}
		}
		for j, v := range acc {
			if v != 0 {
				out.Data[Key{i, j}] = v
			}
		}
	}
	return out, nil
}

// NaiveMultiply is the reference dense triple-loop implementation used to
// cross-check results on small matrices.
func NaiveMultiply(a, b *Matrix) (*Matrix, error) {
	if a.Cols != b.Rows {
		return nil, fmt.Errorf("matrix: dimension mismatch %dx%d times %dx%d", a.Rows, a.Cols, b.Rows, b.Cols)
	}
	out := New(a.Rows, b.Cols)
	for i := 0; i < a.Rows; i++ {
		for j := 0; j < b.Cols; j++ {
			var sum int64
			for k := 0; k < a.Cols; k++ {
				prod, err := checkedMul(a.Get(i, k), b.Get(k, j))
				if err != nil {
					return nil, fmt.Errorf("matrix: C[%d][%d]: %w", i, j, err)
				}
				sum, err = checkedAdd(sum, prod)
				if err != nil {
					return nil, fmt.Errorf("matrix: C[%d][%d]: %w", i, j, err)
				}
			}
			if sum != 0 {
				out.Data[Key{i, j}] = sum
			}
		}
	}
	return out, nil
}

// Change describes one cell that differs between two versions of a matrix.
type Change struct {
	Matrix   string // "A", "B" or "C"
	R, C     int
	Old, New int64
}

// DiffMatrices lists the cell differences between oldM and newM, sorted by
// (row, col). The label is recorded in each Change.
func DiffMatrices(label string, oldM, newM *Matrix) []Change {
	keys := make(map[Key]struct{}, len(oldM.Data)+len(newM.Data))
	for k := range oldM.Data {
		keys[k] = struct{}{}
	}
	for k := range newM.Data {
		keys[k] = struct{}{}
	}
	var out []Change
	for k := range keys {
		ov, nv := oldM.Data[k], newM.Data[k]
		if ov != nv {
			out = append(out, Change{Matrix: label, R: k.R, C: k.C, Old: ov, New: nv})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].R != out[j].R {
			return out[i].R < out[j].R
		}
		return out[i].C < out[j].C
	})
	return out
}
