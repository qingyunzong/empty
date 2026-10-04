package assembly

import (
	"errors"
	"fmt"
	"math/big"
)

// Element is a validated, stored element contribution. Local data is
// deep-copied on insertion so later caller mutations cannot corrupt
// the assembled system.
type Element struct {
	ID      uint64
	Indices []int
	Ke      [][]*big.Rat
	Fe      []*big.Rat
}

// Assembler accumulates element contributions into a global rational
// system A x = b.
type Assembler struct {
	n        int
	a        *Matrix
	b        []*big.Rat
	elements map[uint64]*Element
	nextID   uint64
}

// NewAssembler creates an assembler for a system with n unknowns.
func NewAssembler(n int) (*Assembler, error) {
	if n < 0 {
		return nil, fmt.Errorf("assembly: negative system size %d", n)
	}
	return &Assembler{
		n:        n,
		a:        NewMatrix(n, n),
		b:        make([]*big.Rat, n),
		elements: make(map[uint64]*Element),
	}, nil
}

// Size returns the number of unknowns.
func (s *Assembler) Size() int { return s.n }

// Matrix returns the assembled global matrix.
func (s *Assembler) Matrix() *Matrix { return s.a }

// RHS returns a copy of the assembled right-hand-side vector.
func (s *Assembler) RHS() []*big.Rat {
	out := make([]*big.Rat, s.n)
	for i, v := range s.b {
		out[i] = new(big.Rat).Set(v)
	}
	return out
}

// Element returns the stored element with the given ID, or nil.
func (s *Assembler) Element(id uint64) *Element { return s.elements[id] }

// AddElement validates and scatters an element into the global
// system. ke must be a square local matrix whose dimension equals
// len(indices); fe may be nil or match that length. Repeated global
// indices accumulate. On any validation error the assembler is left
// completely untouched (atomic).
func (s *Assembler) AddElement(ke [][]*big.Rat, fe []*big.Rat, indices []int) (uint64, error) {
	if err := s.validate(ke, fe, indices); err != nil {
		return 0, err
	}
	el := &Element{
		ID:      s.nextID,
		Indices: append([]int(nil), indices...),
		Ke:      copyMatrix(ke),
	}
	if fe != nil {
		el.Fe = append([]*big.Rat(nil), fe...)
		for i := range el.Fe {
			el.Fe[i] = new(big.Rat).Set(fe[i])
		}
	}
	// Scatter only after all validation succeeded.
	for a, gi := range indices {
		for b, gj := range indices {
			s.a.Add(gi, gj, ke[a][b])
		}
		if fe != nil {
			s.addRHS(gi, fe[a])
		}
	}
	s.elements[el.ID] = el
	s.nextID++
	return el.ID, nil
}

// RemoveElement subtracts exactly the contribution of the element
// with the given ID, restoring the system to its prior state. Because
// arithmetic is exact, the rollback is bit-for-bit. Removing an
// unknown ID is an error and changes nothing.
func (s *Assembler) RemoveElement(id uint64) error {
	el, ok := s.elements[id]
	if !ok {
		return fmt.Errorf("assembly: no element with id %d", id)
	}
	for a, gi := range el.Indices {
		for b, gj := range el.Indices {
			s.a.Add(gi, gj, new(big.Rat).Neg(el.Ke[a][b]))
		}
		if el.Fe != nil {
			s.addRHS(gi, new(big.Rat).Neg(el.Fe[a]))
		}
	}
	delete(s.elements, id)
	return nil
}

// ApplyConstraint eliminates the given dof with prescribed value by
// moving its column contribution to the right-hand side:
//
//	b_i <- b_i - A_{i,dof} * value   for all i
//
// then zeroing row and column dof and setting A_{dof,dof} = 1,
// b_dof = value. The eliminated dof's RHS contribution is preserved
// in the remaining equations. Eliminating an already-eliminated dof
// is idempotent: its column is zero, so only the prescribed value is
// rewritten.
func (s *Assembler) ApplyConstraint(dof int, value *big.Rat) error {
	if dof < 0 || dof >= s.n {
		return fmt.Errorf("assembly: constraint dof %d out of range [0,%d)", dof, s.n)
	}
	if value == nil {
		return errors.New("assembly: nil constraint value")
	}
	for i := 0; i < s.n; i++ {
		if aiv := s.a.Get(i, dof); aiv != nil {
			term := new(big.Rat).Mul(aiv, value)
			s.addRHS(i, new(big.Rat).Neg(term))
		}
	}
	for j := 0; j < s.n; j++ {
		s.a.Set(dof, j, nil)
		s.a.Set(j, dof, nil)
	}
	s.a.Set(dof, dof, big.NewRat(1, 1))
	s.b[dof] = new(big.Rat).Set(value)
	return nil
}

// Residual computes r = A x - b exactly for the given vector x.
func (s *Assembler) Residual(x []*big.Rat) ([]*big.Rat, error) {
	if len(x) != s.n {
		return nil, fmt.Errorf("assembly: residual vector length %d, want %d", len(x), s.n)
	}
	r := make([]*big.Rat, s.n)
	for i := 0; i < s.n; i++ {
		acc := new(big.Rat)
		for _, j := range s.a.rowCols(i) {
			acc.Add(acc, new(big.Rat).Mul(s.a.Get(i, j), x[j]))
		}
		r[i] = acc.Sub(acc, s.b[i])
	}
	return r, nil
}

// Certificate is an exact residual certificate for a candidate
// solution of the assembled system.
type Certificate struct {
	Residual []*big.Rat
	MaxAbs   *big.Rat
	Exact    bool
}

// Certify validates a candidate solution x and returns its residual
// certificate. Exact is true iff every residual component is zero.
func (s *Assembler) Certify(x []*big.Rat) (*Certificate, error) {
	r, err := s.Residual(x)
	if err != nil {
		return nil, err
	}
	cert := &Certificate{Residual: r, MaxAbs: new(big.Rat), Exact: true}
	for _, v := range r {
		abs := new(big.Rat).Abs(v)
		if abs.Sign() != 0 {
			cert.Exact = false
			if abs.Cmp(cert.MaxAbs) > 0 {
				cert.MaxAbs.Set(abs)
			}
		}
	}
	return cert, nil
}

func (s *Assembler) addRHS(i int, v *big.Rat) {
	if v == nil || v.Sign() == 0 {
		return
	}
	if s.b[i] == nil {
		s.b[i] = new(big.Rat)
	}
	s.b[i].Add(s.b[i], v)
}

func (s *Assembler) validate(ke [][]*big.Rat, fe []*big.Rat, indices []int) error {
	if len(ke) != len(indices) {
		return fmt.Errorf("assembly: local matrix has %d rows but %d indices", len(ke), len(indices))
	}
	for a, row := range ke {
		if len(row) != len(indices) {
			return fmt.Errorf("assembly: local matrix row %d has %d columns, want %d", a, len(row), len(indices))
		}
		for b, v := range row {
			if v == nil {
				return fmt.Errorf("assembly: nil local matrix entry (%d,%d)", a, b)
			}
		}
	}
	if fe != nil && len(fe) != len(indices) {
		return fmt.Errorf("assembly: local rhs has %d entries but %d indices", len(fe), len(indices))
	}
	for a, v := range fe {
		if v == nil {
			return fmt.Errorf("assembly: nil local rhs entry %d", a)
		}
	}
	for a, g := range indices {
		if g < 0 || g >= s.n {
			return fmt.Errorf("assembly: global index %d at position %d out of range [0,%d)", g, a, s.n)
		}
	}
	return nil
}

func copyMatrix(src [][]*big.Rat) [][]*big.Rat {
	out := make([][]*big.Rat, len(src))
	for i, row := range src {
		out[i] = make([]*big.Rat, len(row))
		for j, v := range row {
			out[i][j] = new(big.Rat).Set(v)
		}
	}
	return out
}
