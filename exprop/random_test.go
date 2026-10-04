package exprop

import (
	"math/rand"
	"testing"
)

// gen builds random small trees, assigning each node a unique position.
type gen struct {
	r    *rand.Rand
	next int
}

func (g *gen) pos(depth int) Pos {
	g.next++
	return Pos{Offset: g.next, Line: g.next, Column: depth}
}

func (g *gen) expr(depth int) Expr {
	if depth <= 0 || g.r.Intn(4) == 0 {
		return &Const{Val: int64(g.r.Intn(7) - 3), At: g.pos(depth)} // [-3,3]
	}
	switch g.r.Intn(10) {
	case 0, 1:
		return &Cond{C: g.expr(depth - 1), T: g.expr(depth - 1), F: g.expr(depth - 1), At: g.pos(depth)}
	case 2, 3:
		return &Binary{Op: OpAnd, L: g.expr(depth - 1), R: g.expr(depth - 1), At: g.pos(depth)}
	case 4:
		return &Binary{Op: OpOr, L: g.expr(depth - 1), R: g.expr(depth - 1), At: g.pos(depth)}
	default:
		ops := []Op{OpAdd, OpSub, OpMul, OpDiv, OpMod, OpEq, OpNe, OpLt, OpLe, OpGt, OpGe}
		return &Binary{Op: ops[g.r.Intn(len(ops))], L: g.expr(depth - 1), R: g.expr(depth - 1), At: g.pos(depth)}
	}
}

// TestRandomProgramsDifferential compares the original interpreter with the
// optimized tree on random small programs: values and the observable
// division-by-zero error sequence (message and position) must be identical.
func TestRandomProgramsDifferential(t *testing.T) {
	const iterations = 20000
	r := rand.New(rand.NewSource(1))
	for i := 0; i < iterations; i++ {
		g := &gen{r: r}
		n := 1 + r.Intn(4)
		prog := make([]Expr, n)
		for j := range prog {
			prog[j] = g.expr(4)
		}
		before := EvalProgram(prog)
		after := EvalProgram(OptimizeProgram(prog))
		if len(before) != len(after) {
			t.Fatalf("iter %d: result count %d != %d", i, len(before), len(after))
		}
		for j := range before {
			b, a := before[j], after[j]
			if (b.Err == nil) != (a.Err == nil) {
				t.Fatalf("iter %d expr %d: err mismatch %v vs %v\nprog: %s", i, j, b.Err, a.Err, dumpAll(prog))
			}
			if b.Err != nil {
				if b.Err.Msg != a.Err.Msg || b.Err.At != a.Err.At {
					t.Fatalf("iter %d expr %d: error %v vs %v\nprog: %s", i, j, b.Err, a.Err, dumpAll(prog))
				}
				continue
			}
			if b.Val != a.Val {
				t.Fatalf("iter %d expr %d: value %d vs %d\nprog: %s", i, j, b.Val, a.Val, dumpAll(prog))
			}
		}
	}
}

func dumpAll(prog []Expr) string {
	s := ""
	for i, e := range prog {
		if i > 0 {
			s += "; "
		}
		s += Dump(e)
	}
	return s
}
