package calib

import (
	"math/rand"
	"testing"
)

func TestRotateQuarterTurns(t *testing.T) {
	cases := []struct {
		rot, x, y, wx, wy int
	}{
		{0, 3, 4, 3, 4},
		{1, 1, 0, 0, 1},
		{2, 1, 0, -1, 0},
		{3, 1, 0, 0, -1},
		{4, 1, 0, 1, 0},   // 旋转规范化
		{-1, 1, 0, 0, -1}, // 负旋转规范化
	}
	for _, c := range cases {
		if x, y := rotate(c.rot, c.x, c.y); x != c.wx || y != c.wy {
			t.Errorf("rotate(%d,%d,%d) = (%d,%d), 期望 (%d,%d)", c.rot, c.x, c.y, x, y, c.wx, c.wy)
		}
	}
}

func TestComposeNonCommutative(t *testing.T) {
	rot := Transform{Rot: 1}
	trans := Transform{DX: 2, DY: 0}
	if rot.Compose(trans) == trans.Compose(rot) {
		t.Fatal("组合顺序应不可交换")
	}
	// 先平移 (2,0) 再转 90°：平移量被旋转为 (0,2)。
	if got := rot.Compose(trans); got != (Transform{Rot: 1, DX: 0, DY: 2}) {
		t.Errorf("rot∘trans = %+v", got)
	}
	// 先转 90° 再平移 (2,0)：平移量不变。
	if got := trans.Compose(rot); got != (Transform{Rot: 1, DX: 2, DY: 0}) {
		t.Errorf("trans∘rot = %+v", got)
	}
}

func TestComposeMatchesApply(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for i := 0; i < 1000; i++ {
		a := randTransform(rng)
		b := randTransform(rng)
		x, y := rng.Intn(21)-10, rng.Intn(21)-10
		// (a∘b)(p) 应等于 a(b(p))。
		ix, iy := b.Apply(x, y)
		ix, iy = a.Apply(ix, iy)
		gx, gy := a.Compose(b).Apply(x, y)
		if ix != gx || iy != gy {
			t.Fatalf("Compose 与逐点作用不一致: %+v ∘ %+v", a, b)
		}
	}
}

func TestInverseAndAssociativity(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	for i := 0; i < 1000; i++ {
		a, b, c := randTransform(rng), randTransform(rng), randTransform(rng)
		if !a.Compose(a.Inverse()).IsIdentity() || !a.Inverse().Compose(a).IsIdentity() {
			t.Fatalf("逆变换不成立: %+v", a)
		}
		if a.Compose(b.Compose(c)) != a.Compose(b).Compose(c) {
			t.Fatalf("结合律不成立")
		}
	}
}

func randTransform(rng *rand.Rand) Transform {
	return Transform{
		Rot: rng.Intn(8) - 4, // 故意超出 [0,4) 以测试规范化
		DX:  rng.Intn(21) - 10,
		DY:  rng.Intn(21) - 10,
	}
}
