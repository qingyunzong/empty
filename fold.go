package intfold

import "fmt"

// Fold constant-folds e and returns a new AST (the input is not mutated).
//
// The folder never reports a compile-time error:
//   - A constant division/modulo by zero in a must-execute position becomes
//     a TrapNode carrying the original source span; it faults at run time.
//   - Branches discarded by short-circuiting (&&, ||, ?:) are dropped
//     without being folded, so a division by zero inside them stays silent.
//
// Every rewrite appends a provenance note to the resulting node.
func Fold(e *Expr) *Expr {
	switch e.Kind {
	case Const, Var, TrapNode:
		return e
	case Unary:
		x := Fold(e.X)
		if x.Kind == Const {
			var v int32
			switch e.Op {
			case OpNeg:
				v = -x.Val
			case OpNot:
				v = boolInt(x.Val == 0)
			}
			return constFrom(e, v, fmt.Sprintf("fold %s(%d) = %d from [%s]",
				e.Op, x.Val, v, e.Span))
		}
		c := *e
		c.X = x
		return &c
	case Binary:
		return foldBinary(e)
	case Cond:
		c := Fold(e.C)
		if c.Kind == Const {
			if c.Val != 0 {
				return withNote(Fold(e.T), fmt.Sprintf(
					"cond at [%s] is constant true: kept then-branch, discarded else-branch [%s] unfolded",
					e.Span, e.F.Span))
			}
			return withNote(Fold(e.F), fmt.Sprintf(
				"cond at [%s] is constant false: kept else-branch, discarded then-branch [%s] unfolded",
				e.Span, e.T.Span))
		}
		cp := *e
		cp.C = c
		cp.T = Fold(e.T)
		cp.F = Fold(e.F)
		return &cp
	}
	return e
}

func foldBinary(e *Expr) *Expr {
	switch e.Op {
	case OpAnd:
		l := Fold(e.L)
		if l.Kind == Const {
			if l.Val == 0 {
				return constFrom(e, 0, fmt.Sprintf(
					"&& left operand is 0: short-circuit, right operand [%s] discarded unfolded", e.R.Span))
			}
			// c && r  ==  r != 0 (r is still evaluated, traps propagate).
			return normalizeTruth(Fold(e.R), e, "&& left operand is non-zero constant")
		}
		r := Fold(e.R)
		c := *e
		c.L, c.R = l, r
		return &c
	case OpOr:
		l := Fold(e.L)
		if l.Kind == Const {
			if l.Val != 0 {
				return constFrom(e, 1, fmt.Sprintf(
					"|| left operand is non-zero: short-circuit, right operand [%s] discarded unfolded", e.R.Span))
			}
			// 0 || r  ==  r != 0 (r is still evaluated, traps propagate).
			return normalizeTruth(Fold(e.R), e, "|| left operand is constant 0")
		}
		r := Fold(e.R)
		c := *e
		c.L, c.R = l, r
		return &c
	default:
		l := Fold(e.L)
		r := Fold(e.R)
		if l.Kind == Const && r.Kind == Const {
			if (e.Op == OpDiv || e.Op == OpMod) && r.Val == 0 {
				name := "division"
				if e.Op == OpMod {
					name = "modulo"
				}
				return &Expr{
					Kind: TrapNode,
					Span: e.Span,
					Msg:  name + " by zero",
					Prov: []string{fmt.Sprintf(
						"must-execute constant %s by zero at [%s]: lowered to run-time trap node (not a compile error)",
						name, e.Span)},
				}
			}
			v := arith(e.Op, l.Val, r.Val)
			return constFrom(e, v, fmt.Sprintf("fold %d %s %d = %d from [%s]",
				l.Val, e.Op, r.Val, v, e.Span))
		}
		c := *e
		c.L, c.R = l, r
		return &c
	}
}

// normalizeTruth rewrites a reduced logical operand r to r != 0 so the
// result stays 0/1 like the original && / || expression.
func normalizeTruth(r *Expr, src *Expr, why string) *Expr {
	if r.Kind == Const {
		return constFrom(src, boolInt(r.Val != 0),
			fmt.Sprintf("%s: reduced to truth value of constant %d", why, r.Val))
	}
	zero := &Expr{Kind: Const, Val: 0, Span: src.Span}
	return &Expr{
		Kind: Binary, Op: OpNe, Span: src.Span, L: r, R: zero,
		Prov: []string{why + ": reduced to (right operand != 0)"},
	}
}

// withNote returns a copy of e with an extra provenance note, so nodes
// shared with the input tree are never mutated.
func withNote(e *Expr, note string) *Expr {
	c := *e
	c.Prov = append(append([]string{}, e.Prov...), note)
	return &c
}

// arith computes a binary op on int32 values with wraparound semantics.
// Callers must guarantee no division/modulo by zero.
func arith(op Op, l, r int32) int32 {
	switch op {
	case OpAdd:
		return l + r
	case OpSub:
		return l - r
	case OpMul:
		return l * r
	case OpDiv:
		return l / r
	case OpMod:
		return l % r
	case OpEq:
		return boolInt(l == r)
	case OpNe:
		return boolInt(l != r)
	case OpLt:
		return boolInt(l < r)
	case OpLe:
		return boolInt(l <= r)
	case OpGt:
		return boolInt(l > r)
	case OpGe:
		return boolInt(l >= r)
	}
	return 0
}

func constFrom(src *Expr, v int32, note string) *Expr {
	return &Expr{Kind: Const, Val: v, Span: src.Span, Prov: []string{note}}
}
