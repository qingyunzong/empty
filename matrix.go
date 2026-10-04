// Package assembly provides an exact rational finite-element style
// assembly library. Elements contribute local rational matrices and
// right-hand-side vectors at global indices; duplicate indices
// accumulate, constraints are eliminated while preserving their
// right-hand-side contributions, and every element can be rolled
// back atomically. All arithmetic uses math/big.Rat so results are
// exact and residuals can serve as certificates.
package assembly

import (
	"fmt"
	"math/big"
	"sort"
)

// Matrix is a sparse matrix of exact rationals keyed by (row, col).
// Zero entries are never stored.
type Matrix struct {
	Rows int
	Cols int
	data map[[2]int]*big.Rat
}

// NewMatrix returns an empty rows x cols rational matrix.
func NewMatrix(rows, cols int) *Matrix {
	if rows < 0 || cols < 0 {
		panic("assembly: negative matrix dimension")
	}
	return &Matrix{Rows: rows, Cols: cols, data: make(map[[2]int]*big.Rat)}
}

// Get returns the entry at (i, j), or nil if it is zero or out of range.
func (m *Matrix) Get(i, j int) *big.Rat {
	if i < 0 || i >= m.Rows || j < 0 || j >= m.Cols {
		return nil
	}
	return m.data[[2]int{i, j}]
}

// At returns a copy of the entry at (i, j); zero when unset.
func (m *Matrix) At(i, j int) *big.Rat {
	if v := m.Get(i, j); v != nil {
		return new(big.Rat).Set(v)
	}
	return new(big.Rat)
}

// Set assigns v to (i, j); a zero value removes the entry.
func (m *Matrix) Set(i, j int, v *big.Rat) {
	m.check(i, j)
	key := [2]int{i, j}
	if v == nil || v.Sign() == 0 {
		delete(m.data, key)
		return
	}
	m.data[key] = new(big.Rat).Set(v)
}

// Add accumulates v into (i, j), removing the entry if it becomes zero.
func (m *Matrix) Add(i, j int, v *big.Rat) {
	m.check(i, j)
	if v == nil || v.Sign() == 0 {
		return
	}
	key := [2]int{i, j}
	if cur, ok := m.data[key]; ok {
		cur.Add(cur, v)
		if cur.Sign() == 0 {
			delete(m.data, key)
		}
	} else {
		m.data[key] = new(big.Rat).Set(v)
	}
}

func (m *Matrix) check(i, j int) {
	if i < 0 || i >= m.Rows || j < 0 || j >= m.Cols {
		panic(fmt.Sprintf("assembly: index (%d,%d) out of %dx%d matrix", i, j, m.Rows, m.Cols))
	}
}

// Entries returns the non-zero entries in sorted (row, col) order.
func (m *Matrix) Entries() [][2]int {
	keys := make([][2]int, 0, len(m.data))
	for k := range m.data {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(a, b int) bool {
		if keys[a][0] != keys[b][0] {
			return keys[a][0] < keys[b][0]
		}
		return keys[a][1] < keys[b][1]
	})
	return keys
}

// Equal reports whether m and o hold identical rational entries.
func (m *Matrix) Equal(o *Matrix) bool {
	if m.Rows != o.Rows || m.Cols != o.Cols || len(m.data) != len(o.data) {
		return false
	}
	for k, v := range m.data {
		ov, ok := o.data[k]
		if !ok || v.Cmp(ov) != 0 {
			return false
		}
	}
	return true
}

// Dense renders the matrix as a dense row-major slice of rationals.
func (m *Matrix) Dense() [][]*big.Rat {
	out := make([][]*big.Rat, m.Rows)
	for i := range out {
		out[i] = make([]*big.Rat, m.Cols)
		for j := range out[i] {
			out[i][j] = m.At(i, j)
		}
	}
	return out
}

// rowCols returns the sorted column indices of non-zero entries in row i.
func (m *Matrix) rowCols(i int) []int {
	var cols []int
	for k := range m.data {
		if k[0] == i {
			cols = append(cols, k[1])
		}
	}
	sort.Ints(cols)
	return cols
}
