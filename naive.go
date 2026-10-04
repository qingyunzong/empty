package matrixlib

import "fmt"

// NaiveMultiply computes a*b with the plain dense triple loop, using checked
// arithmetic. It serves as the reference implementation used to verify the
// incrementally maintained product.
func NaiveMultiply(a, b *Matrix) (*Matrix, error) {
	ar, ac := a.Dims()
	br, bc := b.Dims()
	if ac != br {
		return nil, fmt.Errorf("matrixlib: dimension mismatch %dx%d * %dx%d", ar, ac, br, bc)
	}
	out := NewMatrix(ar, bc)
	for i := 0; i < ar; i++ {
		for j := 0; j < bc; j++ {
			var sum int64
			for k := 0; k < ac; k++ {
				av, bv := a.Get(i, k), b.Get(k, j)
				if av == 0 || bv == 0 {
					continue
				}
				prod, ov := mulChecked(av, bv)
				if ov {
					return nil, fmt.Errorf("%w: A(%d, %d) * B(%d, %d)", ErrOverflow, i, k, k, j)
				}
				sum, ov = addChecked(sum, prod)
				if ov {
					return nil, fmt.Errorf("%w: accumulating C(%d, %d)", ErrOverflow, i, j)
				}
			}
			if sum != 0 {
				if err := out.Set(i, j, sum); err != nil {
					return nil, err
				}
			}
		}
	}
	return out, nil
}

// Check recomputes C = A*B with the naive triple loop and compares it with
// the incrementally maintained C. It returns nil when both agree.
func (e *Engine) Check() error {
	want, err := NaiveMultiply(e.A, e.B)
	if err != nil {
		return err
	}
	if !e.C.Equal(want) {
		return fmt.Errorf("matrixlib: incremental C disagrees with naive product")
	}
	return nil
}
