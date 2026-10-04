package exprop

// Optimize performs constant folding and short-circuit simplification.
//
// Correctness invariants:
//   - The optimized tree yields the same value as the original.
//   - The first observable division-by-zero error (position and message) is
//     unchanged: folding never evaluates a division by zero at optimize time,
//     and never drops a subexpression whose evaluation could raise one.
//   - Branches that the original interpreter would not evaluate (dead side of
//     &&, ||, ?:) may be dropped, because their errors are not observable.
func Optimize(e Expr) Expr {
	switch n := e.(type) {
	case *Const:
		return n
	case *Cond:
		c := Optimize(n.C)
		if k, ok := c.(*Const); ok {
			// The unselected branch is never evaluated, so dropping it
			// cannot hide an observable error.
			if k.Val != 0 {
				return Optimize(n.T)
			}
			return Optimize(n.F)
		}
		t := Optimize(n.T)
		f := Optimize(n.F)
		if tk, ok := t.(*Const); ok {
			if fk, ok := f.(*Const); ok && tk.Val == fk.Val && pure(c) {
				// Both arms agree and the condition cannot raise.
				return tk
			}
		}
		return &Cond{C: c, T: t, F: f, At: n.At}
	case *Binary:
		l := Optimize(n.L)
		r := Optimize(n.R)
		if lk, ok := l.(*Const); ok {
			if rk, ok := r.(*Const); ok {
				if folded, ok := fold(n.Op, lk, rk, n.At); ok {
					return folded
				}
				// Division or modulo by a zero constant: keep the node so
				// the error is still raised at run time, in order.
				return &Binary{Op: n.Op, L: lk, R: rk, At: n.At}
			}
		}
		if s, ok := simplify(n.Op, l, r, n.At); ok {
			return s
		}
		return &Binary{Op: n.Op, L: l, R: r, At: n.At}
	}
	panic("unreachable")
}

// OptimizeProgram optimizes every expression of a program in order.
func OptimizeProgram(exprs []Expr) []Expr {
	out := make([]Expr, len(exprs))
	for i, e := range exprs {
		out[i] = Optimize(e)
	}
	return out
}

// fold evaluates a constant operation. It reports ok=false for the cases that
// must remain as runtime errors (division or modulo by zero).
func fold(op Op, l, r *Const, at Pos) (Expr, bool) {
	c := func(v int64) Expr { return &Const{Val: v, At: at} }
	switch op {
	case OpAdd:
		return c(l.Val + r.Val), true
	case OpSub:
		return c(l.Val - r.Val), true
	case OpMul:
		return c(l.Val * r.Val), true
	case OpDiv:
		if r.Val == 0 {
			return nil, false
		}
		return c(l.Val / r.Val), true
	case OpMod:
		if r.Val == 0 {
			return nil, false
		}
		return c(l.Val % r.Val), true
	case OpAnd:
		if l.Val == 0 {
			return c(0), true
		}
		return c(b2i(r.Val != 0)), true
	case OpOr:
		if l.Val != 0 {
			return c(1), true
		}
		return c(b2i(r.Val != 0)), true
	case OpEq:
		return c(b2i(l.Val == r.Val)), true
	case OpNe:
		return c(b2i(l.Val != r.Val)), true
	case OpLt:
		return c(b2i(l.Val < r.Val)), true
	case OpLe:
		return c(b2i(l.Val <= r.Val)), true
	case OpGt:
		return c(b2i(l.Val > r.Val)), true
	case OpGe:
		return c(b2i(l.Val >= r.Val)), true
	}
	panic("unreachable")
}

// simplify applies short-circuit and identity rewrites. A subexpression may
// only be discarded when the original interpreter would not have evaluated
// it, or when it is pure (cannot raise an observable error).
func simplify(op Op, l, r Expr, at Pos) (Expr, bool) {
	lk, lIsConst := l.(*Const)
	rk, rIsConst := r.(*Const)
	switch op {
	case OpAnd:
		if lIsConst {
			if lk.Val == 0 {
				// r is short-circuited away; its errors are unobservable.
				return &Const{Val: 0, At: at}, true
			}
			// c && r  ==  (r != 0); r is still evaluated, in order.
			return &Binary{Op: OpNe, L: r, R: &Const{Val: 0, At: r.Pos()}, At: at}, true
		}
	case OpOr:
		if lIsConst {
			if lk.Val != 0 {
				return &Const{Val: 1, At: at}, true
			}
			return &Binary{Op: OpNe, L: r, R: &Const{Val: 0, At: r.Pos()}, At: at}, true
		}
	case OpAdd:
		if lIsConst && lk.Val == 0 {
			return r, true
		}
		if rIsConst && rk.Val == 0 {
			return l, true
		}
	case OpSub:
		if rIsConst && rk.Val == 0 {
			return l, true
		}
	case OpMul:
		if lIsConst && lk.Val == 1 {
			return r, true
		}
		if rIsConst && rk.Val == 1 {
			return l, true
		}
		if lIsConst && lk.Val == 0 && pure(r) {
			// Dropping r is only safe because r cannot raise.
			return &Const{Val: 0, At: at}, true
		}
		if rIsConst && rk.Val == 0 && pure(l) {
			return &Const{Val: 0, At: at}, true
		}
	case OpDiv:
		if rIsConst && rk.Val == 1 {
			return l, true
		}
	}
	return nil, false
}

// pure reports whether evaluating e cannot produce a runtime error.
func pure(e Expr) bool {
	switch n := e.(type) {
	case *Const:
		return true
	case *Cond:
		return pure(n.C) && pure(n.T) && pure(n.F)
	case *Binary:
		if n.Op == OpDiv || n.Op == OpMod {
			rk, ok := n.R.(*Const)
			if !ok || rk.Val == 0 {
				return false
			}
		}
		return pure(n.L) && pure(n.R)
	}
	panic("unreachable")
}
