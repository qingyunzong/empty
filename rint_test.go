package rint

import (
	"math/big"
	"testing"
)

func rat(a, b int64) *big.Rat { return big.NewRat(a, b) }

func eq(t *testing.T, got Interval, lo, hi *big.Rat) {
	t.Helper()
	if got.Undef {
		t.Fatalf("期望 [%v, %v]，得到无定义", lo, hi)
	}
	if got.Lo.Cmp(lo) != 0 || got.Hi.Cmp(hi) != 0 {
		t.Fatalf("期望 [%v, %v]，得到 %v", lo, hi, got)
	}
}

func TestIntervalArith(t *testing.T) {
	a := New(rat(-1, 2), rat(2, 1)) // [-1/2, 2]
	b := New(rat(1, 3), rat(3, 1))  // [1/3, 3]
	eq(t, Add(a, b), rat(-1, 6), rat(5, 1))
	eq(t, Sub(a, b), rat(-7, 2), rat(5, 3))
	eq(t, Mul(a, b), rat(-3, 2), rat(6, 1))
	eq(t, Div(a, b), rat(-3, 2), rat(6, 1))
}

func TestDivByZeroContainingIntervalIsUndefined(t *testing.T) {
	a := ConstInt(1)
	for _, d := range []Interval{
		New(rat(-1, 1), rat(1, 1)), // 内部含 0
		New(rat(0, 1), rat(2, 1)),  // 端点为 0
		ConstInt(0),                // 退化为 0
	} {
		if got := Div(a, d); !got.Undef {
			t.Fatalf("1/%v 应无定义，得到 %v", d, got)
		}
	}
	if got := Div(a, New(rat(1, 2), rat(2, 1))); got.Undef {
		t.Fatalf("除数不含 0 不应无定义")
	}
	// 无定义沿运算传播
	if got := Add(Div(a, ConstInt(0)), ConstInt(3)); !got.Undef {
		t.Fatalf("无定义应传播")
	}
}

// 依赖问题：x - x 在 [-1,1] 上朴素区间为 [-2,2]，精确值为 0。
func TestDependencyNaiveVsExact(t *testing.T) {
	e := SubE(VarE(0), VarE(0))
	dom := []Interval{New(rat(-1, 1), rat(1, 1))}

	naive := e.EvalInterval(dom)
	eq(t, naive, rat(-2, 1), rat(2, 1)) // 外包，非精确

	bounds, cert, err := ExactRange(e, dom, []int{4})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, bounds, rat(0, 1), rat(0, 1)) // 网格上精确
	if !cert.Verify(e) {
		t.Fatalf("证书核对失败")
	}
}

// 依赖问题：x*(1-x) 在 [0,1] 上朴素区间为 [0,1]，精确最大值为 1/4。
func TestDependencyQuadratic(t *testing.T) {
	e := MulE(VarE(0), SubE(ConstIntE(1), VarE(0)))
	dom := []Interval{ConstInt(0)}
	dom[0] = New(rat(0, 1), rat(1, 1))

	naive := e.EvalInterval(dom)
	eq(t, naive, rat(0, 1), rat(1, 1))

	bounds, cert, err := ExactRange(e, dom, []int{2}) // 网格点 0, 1/2, 1
	if err != nil {
		t.Fatal(err)
	}
	eq(t, bounds, rat(0, 1), rat(1, 4))
	if cert.MaxAt[0].Cmp(rat(1, 2)) != 0 {
		t.Fatalf("最大值点应为 1/2，得到 %v", cert.MaxAt[0])
	}
	if !cert.Verify(e) {
		t.Fatalf("证书核对失败")
	}
}

// 分支：if(x>0, x, -x) = |x|，在 [-2,3] 上朴素包络为 [-3,3]，精确为 [0,3]。
func TestBranchAbs(t *testing.T) {
	e := IfE(VarE(0), VarE(0), SubE(ConstIntE(0), VarE(0)))
	dom := []Interval{New(rat(-2, 1), rat(3, 1))}

	naive := e.EvalInterval(dom)
	eq(t, naive, rat(-3, 1), rat(3, 1)) // 条件跨 0，取两分支包络

	bounds, cert, err := ExactRange(e, dom, []int{5})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, bounds, rat(0, 1), rat(3, 1))
	if !cert.Verify(e) {
		t.Fatalf("证书核对失败")
	}
}

// 分支条件恒真/恒假时只取对应分支。
func TestBranchDeterminate(t *testing.T) {
	thenE := IfE(ConstIntE(1), ConstIntE(10), DivE(ConstIntE(1), ConstIntE(0)))
	if got := thenE.EvalInterval(nil); got.Undef || got.Lo.Cmp(rat(10, 1)) != 0 {
		t.Fatalf("恒真分支应取 then=10，得到 %v", got)
	}
	elseE := IfE(ConstIntE(-1), DivE(ConstIntE(1), ConstIntE(0)), ConstIntE(7))
	if got := elseE.EvalInterval(nil); got.Undef || got.Lo.Cmp(rat(7, 1)) != 0 {
		t.Fatalf("恒假分支应取 else=7，得到 %v", got)
	}
}

// 表达式中的除法：1/x 在含 0 定义域上区间求值无定义；
// 网格枚举跳过 x=0 的点，给出有定义点上的精确界。
func TestDivisionOnGrid(t *testing.T) {
	e := DivE(ConstIntE(1), VarE(0))
	dom := []Interval{New(rat(-1, 1), rat(1, 1))}

	if got := e.EvalInterval(dom); !got.Undef {
		t.Fatalf("1/x 在含 0 区间上应无定义，得到 %v", got)
	}

	bounds, cert, err := ExactRange(e, dom, []int{2}) // 点 -1, 0, 1
	if err != nil {
		t.Fatal(err)
	}
	eq(t, bounds, rat(-1, 1), rat(1, 1))
	if cert.Undefined != 1 || cert.Evaluated != 2 {
		t.Fatalf("应跳过 1 个无定义点，证书=%+v", cert)
	}
	if !cert.Verify(e) {
		t.Fatalf("证书核对失败")
	}
}

// 篡改的证书必须核对失败。
func TestCertificateTampering(t *testing.T) {
	e := AddE(VarE(0), VarE(1))
	dom := []Interval{New(rat(0, 1), rat(1, 1)), New(rat(0, 1), rat(1, 1))}
	_, cert, err := ExactRange(e, dom, []int{1, 1})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, cert.Bounds(), rat(0, 1), rat(2, 1))
	if !cert.Verify(e) {
		t.Fatalf("原始证书应核对通过")
	}
	bad := cert
	bad.Max = rat(3, 1)
	if bad.Verify(e) {
		t.Fatalf("篡改后的证书不应通过核对")
	}
}

// 变量数上限为 6。
func TestMaxVars(t *testing.T) {
	mk := func(n int) []Interval {
		d := make([]Interval, n)
		for i := range d {
			d[i] = ConstInt(0)
		}
		return d
	}
	steps := func(n int) []int {
		s := make([]int, n)
		for i := range s {
			s[i] = 1
		}
		return s
	}
	if _, err := NewGrid(mk(6), steps(6)); err != nil {
		t.Fatalf("6 个变量应被允许: %v", err)
	}
	if _, err := NewGrid(mk(7), steps(7)); err == nil {
		t.Fatalf("7 个变量应被拒绝")
	}
}

// 网格总点数超限时拒绝。
func TestGridTooLarge(t *testing.T) {
	dom := []Interval{ConstInt(0), ConstInt(0)}
	dom[0] = New(rat(0, 1), rat(1, 1))
	dom[1] = New(rat(0, 1), rat(1, 1))
	if _, err := NewGrid(dom, []int{2000, 2000}); err == nil {
		t.Fatalf("4,004,001 个网格点应被拒绝")
	}
}

// 表达式引用的变量超出网格维度时报错。
func TestExprVarOutOfRange(t *testing.T) {
	e := AddE(VarE(0), VarE(2))
	g, err := NewGrid([]Interval{ConstInt(0)}, []int{1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Enumerate(e, g); err == nil {
		t.Fatalf("引用 x2 但网格只有 1 维，应报错")
	}
}

// 全部点无定义时返回错误。
func TestAllUndefined(t *testing.T) {
	e := DivE(ConstIntE(1), SubE(VarE(0), VarE(0))) // 1/(x-x)
	dom := []Interval{New(rat(0, 1), rat(1, 1))}
	if _, _, err := ExactRange(e, dom, []int{4}); err == nil {
		t.Fatalf("所有点无定义应报错")
	}
}

// 6 变量网格上的精确求值：sum xi，dom [0,1]^6，精确 [0,6]。
func TestSixVars(t *testing.T) {
	e := VarE(0)
	for i := 1; i < 6; i++ {
		e = AddE(e, VarE(i))
	}
	dom := make([]Interval, 6)
	steps := make([]int, 6)
	for i := range dom {
		dom[i] = New(rat(0, 1), rat(1, 1))
		steps[i] = 2
	}
	bounds, cert, err := ExactRange(e, dom, steps)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, bounds, rat(0, 1), rat(6, 1))
	if cert.GridPoints != 729 {
		t.Fatalf("网格点数应为 3^6=729，得到 %d", cert.GridPoints)
	}
	if !cert.Verify(e) {
		t.Fatalf("证书核对失败")
	}
}
