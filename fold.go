package foldexpr

// Fold constant-folds n using 32-bit wraparound arithmetic.
//
// Rules:
//   - Constant subexpressions are evaluated at fold time.
//   - A constant division or remainder by zero becomes a *Trap node
//     (a run-time trap), never a compile-time error.
//   - Short-circuit operators ("&&", "||", "?:") discard branches
//     that can never execute; a division by zero inside a discarded
//     branch disappears with it and is not reported.
//   - Algebraic identities (x+0, x*1, x*0, ...) are applied only when
//     the discarded side cannot trap (no Trap node and no division or
//     remainder with a possibly-zero divisor), so a run-time trap is
//     never folded away.
//
// The result is semantically equivalent to n: Eval before and after
// folding yields the same value, or a *TrapError at the same source
// position.
func Fold(n Node) Node {
	switch n := n.(type) {
	case *Const, *Var, *Trap:
		return n
	case *Unary:
		x := Fold(n.X)
		if c, ok := x.(*Const); ok {
			switch n.Op {
			case "-":
				return &Const{P: n.P, Val: -c.Val}
			case "!":
				return &Const{P: n.P, Val: boolConst(c.Val == 0)}
			}
		}
		return &Unary{P: n.P, Op: n.Op, X: x}
	case *Cond:
		c := Fold(n.C)
		if k, ok := c.(*Const); ok {
			if k.Val != 0 {
				return Fold(n.T)
			}
			return Fold(n.F)
		}
		return &Cond{P: n.P, C: c, T: Fold(n.T), F: Fold(n.F)}
	case *Binary:
		return foldBinary(n)
	}
	return n
}

func foldBinary(n *Binary) Node {
	l := Fold(n.L)
	r := Fold(n.R)
	lc, lok := l.(*Const)
	rc, rok := r.(*Const)

	switch n.Op {
	case "&&":
		if lok {
			if lc.Val == 0 {
				// Short-circuit: r is never evaluated; discard it
				// (including any constant division by zero).
				return &Const{P: n.P, Val: 0}
			}
			return foldBool(r, n.P)
		}
		if rok {
			if rc.Val == 0 {
				if !mayTrap(l) {
					return &Const{P: n.P, Val: 0}
				}
			} else {
				return foldBool(l, n.P)
			}
		}
		return &Binary{P: n.P, Op: "&&", L: l, R: r}
	case "||":
		if lok {
			if lc.Val != 0 {
				return &Const{P: n.P, Val: 1}
			}
			return foldBool(r, n.P)
		}
		if rok {
			if rc.Val != 0 {
				if !mayTrap(l) {
					return &Const{P: n.P, Val: 1}
				}
			} else {
				return foldBool(l, n.P)
			}
		}
		return &Binary{P: n.P, Op: "||", L: l, R: r}
	}

	if lok && rok {
		switch n.Op {
		case "+":
			return &Const{P: n.P, Val: lc.Val + rc.Val}
		case "-":
			return &Const{P: n.P, Val: lc.Val - rc.Val}
		case "*":
			return &Const{P: n.P, Val: lc.Val * rc.Val}
		case "/":
			if rc.Val == 0 {
				return &Trap{P: n.P, Reason: "division by zero"}
			}
			return &Const{P: n.P, Val: lc.Val / rc.Val}
		case "%":
			if rc.Val == 0 {
				return &Trap{P: n.P, Reason: "remainder by zero"}
			}
			return &Const{P: n.P, Val: lc.Val % rc.Val}
		case "==":
			return &Const{P: n.P, Val: boolConst(lc.Val == rc.Val)}
		case "!=":
			return &Const{P: n.P, Val: boolConst(lc.Val != rc.Val)}
		case "<":
			return &Const{P: n.P, Val: boolConst(lc.Val < rc.Val)}
		case "<=":
			return &Const{P: n.P, Val: boolConst(lc.Val <= rc.Val)}
		case ">":
			return &Const{P: n.P, Val: boolConst(lc.Val > rc.Val)}
		case ">=":
			return &Const{P: n.P, Val: boolConst(lc.Val >= rc.Val)}
		}
	}

	// Algebraic identities. A side may only be discarded when it
	// cannot trap, otherwise a run-time trap would be silently
	// removed.
	switch n.Op {
	case "+":
		if rok && rc.Val == 0 {
			return l
		}
		if lok && lc.Val == 0 {
			return r
		}
	case "-":
		if rok && rc.Val == 0 {
			return l
		}
	case "*":
		if rok {
			if rc.Val == 1 {
				return l
			}
			if rc.Val == 0 && !mayTrap(l) {
				return &Const{P: n.P, Val: 0}
			}
		}
		if lok {
			if lc.Val == 1 {
				return r
			}
			if lc.Val == 0 && !mayTrap(r) {
				return &Const{P: n.P, Val: 0}
			}
		}
	}
	return &Binary{P: n.P, Op: n.Op, L: l, R: r}
}

// foldBool rewrites x as (x != 0), normalizing to 0/1.
func foldBool(x Node, p int) Node {
	if c, ok := x.(*Const); ok {
		return &Const{P: p, Val: boolConst(c.Val != 0)}
	}
	return &Binary{P: p, Op: "!=", L: x, R: &Const{P: p, Val: 0}}
}

// mayTrap reports whether evaluating n could produce a run-time trap:
// it contains a Trap node, or a division/remainder whose divisor is
// not a nonzero constant.
func mayTrap(n Node) bool {
	switch n := n.(type) {
	case *Trap:
		return true
	case *Unary:
		return mayTrap(n.X)
	case *Binary:
		switch n.Op {
		case "/", "%":
			if c, ok := n.R.(*Const); !ok || c.Val == 0 {
				return true
			}
		}
		return mayTrap(n.L) || mayTrap(n.R)
	case *Cond:
		return mayTrap(n.C) || mayTrap(n.T) || mayTrap(n.F)
	}
	return false
}
