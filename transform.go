// Package robocalib maintains relative-pose constraints between robots.
//
// A pose constraint combines an integer 2D translation with a rotation by a
// multiple of 90 degrees. Transforms form a non-commutative group: Compose
// order matters and is applied strictly as documented.
package robocalib

// Transform maps a point p to R*p + t, where R is the rotation by
// Rot*90 degrees counter-clockwise and t = (Dx, Dy).
type Transform struct {
	Rot int // quarter turns counter-clockwise, normalized to [0,4)
	Dx  int
	Dy  int
}

// Identity is the neutral element of the transform group.
func Identity() Transform { return Transform{} }

func normRot(r int) int {
	r %= 4
	if r < 0 {
		r += 4
	}
	return r
}

// NewTransform builds a transform with the rotation normalized to [0,4).
func NewTransform(rot, dx, dy int) Transform {
	return Transform{Rot: normRot(rot), Dx: dx, Dy: dy}
}

// rotate applies the rotation part of t to the vector (x, y).
func (t Transform) rotate(x, y int) (int, int) {
	switch t.Rot {
	case 0:
		return x, y
	case 1:
		return -y, x
	case 2:
		return -x, -y
	default: // 3
		return y, -x
	}
}

// Apply maps the point (x, y) through t.
func (t Transform) Apply(x, y int) (int, int) {
	rx, ry := t.rotate(x, y)
	return rx + t.Dx, ry + t.Dy
}

// Compose returns t∘o: the transform that applies o first, then t.
// Composition is not commutative; callers must respect operand order.
func (t Transform) Compose(o Transform) Transform {
	rx, ry := t.rotate(o.Dx, o.Dy)
	return Transform{
		Rot: normRot(t.Rot + o.Rot),
		Dx:  rx + t.Dx,
		Dy:  ry + t.Dy,
	}
}

// Inverse returns the group inverse of t.
func (t Transform) Inverse() Transform {
	inv := Transform{Rot: normRot(-t.Rot)}
	rx, ry := inv.rotate(t.Dx, t.Dy)
	inv.Dx, inv.Dy = -rx, -ry
	return inv
}

// Equal reports whether two transforms are identical.
func (t Transform) Equal(o Transform) bool { return t == o }

// IsIdentity reports whether t is the identity transform.
func (t Transform) IsIdentity() bool { return t == Transform{} }
