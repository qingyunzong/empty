package calib

// Transform 是平面刚体变换：先旋转 Rot*90 度（逆时针），再平移 (DX, DY)。
// 作用于点 p 的结果为 R*p + t。旋转与平移均为整数，组合顺序不可交换。
type Transform struct {
	Rot int // 四分之一圈数，规范到 [0,4)
	DX  int
	DY  int
}

// Identity 返回恒等变换。
func Identity() Transform { return Transform{} }

func normRot(r int) int {
	r %= 4
	if r < 0 {
		r += 4
	}
	return r
}

func rotate(rot, x, y int) (int, int) {
	switch normRot(rot) {
	case 0:
		return x, y
	case 1:
		return -y, x
	case 2:
		return -x, -y
	default:
		return y, -x
	}
}

// Compose 返回 t ∘ o：先施加 o，再施加 t。组合顺序不可交换。
func (t Transform) Compose(o Transform) Transform {
	x, y := rotate(t.Rot, o.DX, o.DY)
	return Transform{Rot: normRot(t.Rot + o.Rot), DX: x + t.DX, DY: y + t.DY}
}

// Inverse 返回逆变换，满足 t ∘ t.Inverse() == Identity()。
func (t Transform) Inverse() Transform {
	invRot := normRot(-t.Rot)
	x, y := rotate(invRot, -t.DX, -t.DY)
	return Transform{Rot: invRot, DX: x, DY: y}
}

// Apply 将变换作用于点 (x, y)。
func (t Transform) Apply(x, y int) (int, int) {
	rx, ry := rotate(t.Rot, x, y)
	return rx + t.DX, ry + t.DY
}

// IsIdentity 报告是否为恒等变换。
func (t Transform) IsIdentity() bool { return t == Transform{} }
