package mat5

import "fmt"

// Table is the immutable result of a successful parse. It is published only
// after every element validated; a failed parse never yields a half table.
type Table struct {
	vars []Variable
}

// Variables returns the parsed top-level variables in input order.
func (t *Table) Variables() []Variable {
	out := make([]Variable, len(t.vars))
	copy(out, t.vars)
	return out
}

// Lookup finds a top-level variable by name.
func (t *Table) Lookup(name string) (Value, bool) {
	for i := range t.vars {
		if t.vars[i].Name == name {
			return t.vars[i].Value, true
		}
	}
	return nil, false
}

// Get resolves a value by variable name, then a cell index chain (one linear
// column-major index per nesting level), then a full numeric coordinate whose
// length must match the final matrix's dimension count.
//
// Example: tbl.Get("s", 0, 2, 1, 3) enters cell slot 0, then cell slot 2, and
// reads coordinate [1,3] of the numeric matrix reached there.
func (t *Table) Get(name string, chainAndCoord ...int32) (Scalar, Value, error) {
	v, ok := t.Lookup(name)
	if !ok {
		return Scalar{}, nil, fmt.Errorf("%w: variable %q", ErrName, name)
	}
	// Walk the cell index chain while the current value is a cell.
	pos := 0
	for {
		cell, isCell := v.(*CellMatrix)
		if !isCell {
			break
		}
		if pos >= len(chainAndCoord) {
			return Scalar{}, v, nil
		}
		child, err := cell.At(chainAndCoord[pos])
		if err != nil {
			return Scalar{}, nil, err
		}
		v = child
		pos++
	}
	coord := chainAndCoord[pos:]
	switch m := v.(type) {
	case *DoubleMatrix:
		if len(coord) == 0 {
			return Scalar{}, m, nil
		}
		real, imag, err := m.At(coord...)
		if err != nil {
			return Scalar{}, nil, err
		}
		return Scalar{
			Class:   ClassDouble,
			Real:    real,
			Imag:    imag,
			Complex: m.Complex(),
		}, m, nil
	case *Int32Matrix:
		if len(coord) == 0 {
			return Scalar{}, m, nil
		}
		n, err := m.At(coord...)
		if err != nil {
			return Scalar{}, nil, err
		}
		return Scalar{Class: ClassInt32, Real: uint64(uint32(n))}, m, nil
	default:
		return Scalar{}, v, nil
	}
}

// colMajorOffset converts a full multidimensional coordinate into a linear
// index where the first dimension varies fastest.
func colMajorOffset(dims, coord []int32) (uint64, error) {
	if len(coord) != len(dims) {
		return 0, fmt.Errorf("%w: coordinate has %d dimensions, matrix has %d",
			ErrIndex, len(coord), len(dims))
	}
	var off, stride uint64 = 0, 1
	for i := range dims {
		c := coord[i]
		d := dims[i]
		if c < 0 || c >= d {
			return 0, fmt.Errorf("%w: coordinate %d out of range [0,%d) on dim %d",
				ErrIndex, c, d, i)
		}
		off += stride * uint64(c)
		stride *= uint64(d)
	}
	return off, nil
}
