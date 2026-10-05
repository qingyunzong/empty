// Package assemble provides an exact rational finite-element style
// assembly library. Elements contribute local matrices and right-hand
// side vectors together with global indices; duplicate indices
// accumulate. Elements can be undone atomically, linear constraints
// are eliminated while preserving their right-hand side contribution,
// and residual certificates verify candidate solutions exactly.
package assemble

import (
	"errors"
	"fmt"
	"math/big"
)

// Element is a single assembly unit: a local dense matrix, a local
// right-hand side vector, and the global indices they map to.
// Indices may repeat; repeated contributions accumulate.
type Element struct {
	Matrix  [][]*big.Rat
	RHS     []*big.Rat
	Indices []int
}

// NewElement builds an element from integer-valued local data.
func NewElement(matrix [][]int64, rhs []int64, indices []int) *Element {
	m := make([][]*big.Rat, len(matrix))
	for i, row := range matrix {
		m[i] = make([]*big.Rat, len(row))
		for j, v := range row {
			m[i][j] = big.NewRat(v, 1)
		}
	}
	b := make([]*big.Rat, len(rhs))
	for i, v := range rhs {
		b[i] = big.NewRat(v, 1)
	}
	idx := make([]int, len(indices))
	copy(idx, indices)
	return &Element{Matrix: m, RHS: b, Indices: idx}
}

// validate checks an element against the global dimension n.
func validate(el *Element, n int) error {
	if el == nil {
		return errors.New("assemble: nil element")
	}
	if len(el.Matrix) != len(el.Indices) {
		return fmt.Errorf("assemble: matrix has %d rows but %d indices", len(el.Matrix), len(el.Indices))
	}
	if len(el.RHS) != len(el.Indices) {
		return fmt.Errorf("assemble: rhs has %d entries but %d indices", len(el.RHS), len(el.Indices))
	}
	for i, row := range el.Matrix {
		if len(row) != len(el.Indices) {
			return fmt.Errorf("assemble: matrix row %d has %d entries, want %d", i, len(row), len(el.Indices))
		}
	}
	for _, g := range el.Indices {
		if g < 0 || g >= n {
			return fmt.Errorf("assemble: global index %d out of range [0,%d)", g, n)
		}
	}
	return nil
}

// Assembler accumulates element contributions into a global system
// A x = b with exact rational arithmetic. A journal of applied
// elements supports atomic undo.
type Assembler struct {
	n       int
	a       map[[2]int]*big.Rat
	b       map[int]*big.Rat
	journal []*Element
}

// New creates an assembler for a system with n global unknowns.
func New(n int) *Assembler {
	if n < 0 {
		panic("assemble: negative dimension")
	}
	return &Assembler{
		n: n,
		a: make(map[[2]int]*big.Rat),
		b: make(map[int]*big.Rat),
	}
}

// Dim returns the global system dimension.
func (s *Assembler) Dim() int { return s.n }

// Len returns the number of applied (not yet undone) elements.
func (s *Assembler) Len() int { return len(s.journal) }

// scatter adds (sign=+1) or subtracts (sign=-1) an element's
// contribution. Duplicate global indices accumulate.
func (s *Assembler) scatter(el *Element, sign int64) {
	sgn := big.NewRat(sign, 1)
	for li, gi := range el.Indices {
		if el.RHS[li] != nil && el.RHS[li].Sign() != 0 {
			cur := s.b[gi]
			if cur == nil {
				cur = new(big.Rat)
			}
			cur.Add(cur, new(big.Rat).Mul(sgn, el.RHS[li]))
			if cur.Sign() == 0 {
				delete(s.b, gi)
			} else {
				s.b[gi] = cur
			}
		}
		for lj, gj := range el.Indices {
			v := el.Matrix[li][lj]
			if v == nil || v.Sign() == 0 {
				continue
			}
			k := [2]int{gi, gj}
			cur := s.a[k]
			if cur == nil {
				cur = new(big.Rat)
			}
			cur.Add(cur, new(big.Rat).Mul(sgn, v))
			if cur.Sign() == 0 {
				delete(s.a, k)
			} else {
				s.a[k] = cur
			}
		}
	}
}

// Add applies an element. The operation is atomic: if the element is
// invalid, the assembler is left untouched and an error is returned.
func (s *Assembler) Add(el *Element) error {
	if err := validate(el, s.n); err != nil {
		return err
	}
	s.scatter(el, +1)
	s.journal = append(s.journal, el)
	return nil
}

// Undo removes the most recently added element, restoring the exact
// prior state. It is atomic: either the full contribution is rolled
// back or, when no element remains, nothing changes.
func (s *Assembler) Undo() error {
	if len(s.journal) == 0 {
		return errors.New("assemble: nothing to undo")
	}
	el := s.journal[len(s.journal)-1]
	s.journal = s.journal[:len(s.journal)-1]
	s.scatter(el, -1)
	return nil
}

// At returns the assembled matrix entry (i,j), or zero.
func (s *Assembler) At(i, j int) *big.Rat {
	if v, ok := s.a[[2]int{i, j}]; ok {
		return new(big.Rat).Set(v)
	}
	return new(big.Rat)
}

// RHSAt returns the assembled right-hand side entry i, or zero.
func (s *Assembler) RHSAt(i int) *big.Rat {
	if v, ok := s.b[i]; ok {
		return new(big.Rat).Set(v)
	}
	return new(big.Rat)
}

// Matrix returns the assembled system as a dense n x n rational matrix.
func (s *Assembler) Matrix() [][]*big.Rat {
	m := make([][]*big.Rat, s.n)
	for i := range m {
		m[i] = make([]*big.Rat, s.n)
		for j := range m[i] {
			m[i][j] = s.At(i, j)
		}
	}
	return m
}

// RHS returns the assembled right-hand side as a dense vector.
func (s *Assembler) RHS() []*big.Rat {
	b := make([]*big.Rat, s.n)
	for i := range b {
		b[i] = s.RHSAt(i)
	}
	return b
}

// Eliminate applies the Dirichlet constraint x[dof] = value by
// moving the column contribution to the right-hand side:
// b_j -= A_jdof * value for all j, then zeroing row and column dof
// and setting A_dofdof = 1, b_dof = value. The constraint's
// right-hand side contribution is therefore preserved exactly.
func (s *Assembler) Eliminate(dof int, value *big.Rat) error {
	if dof < 0 || dof >= s.n {
		return fmt.Errorf("assemble: dof %d out of range [0,%d)", dof, s.n)
	}
	if value == nil {
		return errors.New("assemble: nil constraint value")
	}
	// Move column contribution to the RHS.
	for j := 0; j < s.n; j++ {
		k := [2]int{j, dof}
		col := s.a[k]
		if col == nil || col.Sign() == 0 {
			continue
		}
		cur := s.b[j]
		if cur == nil {
			cur = new(big.Rat)
		}
		cur.Sub(cur, new(big.Rat).Mul(col, value))
		if cur.Sign() == 0 {
			delete(s.b, j)
		} else {
			s.b[j] = cur
		}
	}
	// Zero row and column dof.
	for j := 0; j < s.n; j++ {
		delete(s.a, [2]int{dof, j})
		delete(s.a, [2]int{j, dof})
	}
	// Impose the identity row.
	s.a[[2]int{dof, dof}] = big.NewRat(1, 1)
	if value.Sign() == 0 {
		delete(s.b, dof)
	} else {
		s.b[dof] = new(big.Rat).Set(value)
	}
	return nil
}

// Certificate is an exact residual certificate for a candidate
// solution x of the assembled system A x = b.
type Certificate struct {
	Residual []*big.Rat // r = A x - b, componentwise
	MaxNorm  *big.Rat   // max_i |r_i|
	Exact    bool       // true iff r == 0
}

// Certify computes the residual certificate r = A x - b for a
// candidate solution x. Degenerate systems (zero dimension, empty
// rows, singular matrices) are handled uniformly.
func (s *Assembler) Certify(x []*big.Rat) (*Certificate, error) {
	if len(x) != s.n {
		return nil, fmt.Errorf("assemble: solution has %d entries, want %d", len(x), s.n)
	}
	res := make([]*big.Rat, s.n)
	maxNorm := new(big.Rat)
	exact := true
	for i := 0; i < s.n; i++ {
		r := new(big.Rat).Neg(s.RHSAt(i))
		for j := 0; j < s.n; j++ {
			if x[j] == nil {
				return nil, fmt.Errorf("assemble: nil solution entry %d", j)
			}
			a := s.At(i, j)
			if a.Sign() != 0 && x[j].Sign() != 0 {
				r.Add(r, new(big.Rat).Mul(a, x[j]))
			}
		}
		res[i] = r
		abs := new(big.Rat).Abs(r)
		if abs.Cmp(maxNorm) > 0 {
			maxNorm.Set(abs)
		}
		if r.Sign() != 0 {
			exact = false
		}
	}
	return &Certificate{Residual: res, MaxNorm: maxNorm, Exact: exact}, nil
}

// DenseAssemble independently assembles the given elements into a
// dense matrix and right-hand side using straightforward loops. It
// serves as a cross-check reference for Assembler add/undo sequences.
func DenseAssemble(n int, elements []*Element) ([][]*big.Rat, []*big.Rat, error) {
	a := make([][]*big.Rat, n)
	for i := range a {
		a[i] = make([]*big.Rat, n)
		for j := range a[i] {
			a[i][j] = new(big.Rat)
		}
	}
	b := make([]*big.Rat, n)
	for i := range b {
		b[i] = new(big.Rat)
	}
	for _, el := range elements {
		if err := validate(el, n); err != nil {
			return nil, nil, err
		}
		for li, gi := range el.Indices {
			if el.RHS[li] != nil {
				b[gi].Add(b[gi], el.RHS[li])
			}
			for lj, gj := range el.Indices {
				if el.Matrix[li][lj] != nil {
					a[gi][gj].Add(a[gi][gj], el.Matrix[li][lj])
				}
			}
		}
	}
	return a, b, nil
}
