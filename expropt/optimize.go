package expropt

// Optimize returns an optimized copy-equivalent of n (n itself is not
// mutated; children are rewritten bottom-up into new nodes).
//
// Guarantees:
//   - Eval(Optimize(n)) yields the same value as Eval(n).
//   - If Eval(n) fails, Eval(Optimize(n)) fails with the *same*
//     *DivZeroError (same position); division by zero is never folded
//     into a compile-time error.
//   - Branches that the interpreter would never evaluate (dead side of
//     && / || with a constant guard) are dropped, so they can no longer
//     error — matching the interpreter, which also never touches them.
func Optimize(n Node) Node {
	switch n := n.(type) {
	case *Const:
		return n
	case *Truthy:
		x := Optimize(n.X)
		if c, ok := x.(*Const); ok {
			return &Const{Val: b2i(c.Val != 0), At: n.At}
		}
		return &Truthy{X: x, At: n.At}
	case *Binary:
		return optimizeBinary(n)
	}
	return n
}

func optimizeBinary(n *Binary) Node {
	l := Optimize(n.L)
	r := Optimize(n.R)
	lc, lIsConst := l.(*Const)
	rc, rIsConst := r.(*Const)

	switch n.Op {
	case And:
		// Short-circuit: a constant left operand decides whether R runs.
		if lIsConst {
			if lc.Val == 0 {
				return &Const{Val: 0, At: n.At} // R never evaluated; drop it
			}
			return truthy(r, n.At)
		}
	case Or:
		if lIsConst {
			if lc.Val != 0 {
				return &Const{Val: 1, At: n.At} // R never evaluated; drop it
			}
			return truthy(r, n.At)
		}
	case Mul:
		if lIsConst && lc.Val == 0 && !MayError(r) {
			return &Const{Val: 0, At: n.At}
		}
		if rIsConst && rc.Val == 0 && !MayError(l) {
			return &Const{Val: 0, At: n.At}
		}
		if lIsConst && lc.Val == 1 {
			return r
		}
		if rIsConst && rc.Val == 1 {
			return l
		}
	case Add:
		if lIsConst && lc.Val == 0 {
			return r
		}
		if rIsConst && rc.Val == 0 {
			return l
		}
	case Sub:
		if rIsConst && rc.Val == 0 {
			return l
		}
	case Div:
		if rIsConst && rc.Val == 1 {
			return l
		}
		// Never fold x/0: the error must surface at run time, in order.
	}

	// Constant folding. Both operands are pure constants, so folding
	// cannot remove or reorder any observable error — except x/0, which
	// is deliberately kept as a runtime error.
	if lIsConst && rIsConst {
		if folded, ok := foldConst(n.Op, lc.Val, rc.Val, n.At); ok {
			return folded
		}
	}
	return &Binary{Op: n.Op, L: l, R: r, At: n.At}
}

// truthy wraps r in a Truthy node, folding immediately when r is constant.
func truthy(r Node, at int) Node {
	if c, ok := r.(*Const); ok {
		return &Const{Val: b2i(c.Val != 0), At: at}
	}
	return &Truthy{X: r, At: at}
}

// foldConst folds op(l, r) over constants. It reports ok=false exactly
// when folding would destroy an observable runtime error (division by
// zero), in which case the node must be kept.
func foldConst(op Op, l, r int64, at int) (Node, bool) {
	c := func(v int64) (Node, bool) { return &Const{Val: v, At: at}, true }
	switch op {
	case Add:
		return c(l + r)
	case Sub:
		return c(l - r)
	case Mul:
		return c(l * r)
	case Div:
		if r == 0 {
			return nil, false // keep the runtime error
		}
		return c(l / r)
	case Eq:
		return c(b2i(l == r))
	case Ne:
		return c(b2i(l != r))
	case Lt:
		return c(b2i(l < r))
	case Le:
		return c(b2i(l <= r))
	case Gt:
		return c(b2i(l > r))
	case Ge:
		return c(b2i(l >= r))
	case And:
		return c(b2i(l != 0 && r != 0))
	case Or:
		return c(b2i(l != 0 || r != 0))
	}
	return nil, false
}

// MayError reports whether evaluating n can produce a DivZeroError.
// It is exact for this language: only a Div whose divisor is not a
// nonzero constant can fail.
func MayError(n Node) bool {
	switch n := n.(type) {
	case *Const:
		return false
	case *Truthy:
		return MayError(n.X)
	case *Binary:
		if n.Op == Div {
			if c, ok := n.R.(*Const); !ok || c.Val == 0 {
				return true
			}
		}
		return MayError(n.L) || MayError(n.R)
	}
	return true // conservative for unknown nodes
}
