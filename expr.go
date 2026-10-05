package interval

import "math/big"

// Expr is an arithmetic expression tree over rational constants and
// variables. Variables are referenced by index into an environment.
type Expr interface{ exprNode() }

// Const is a rational constant.
type Const struct{ R *big.Rat }

// Var references the i-th variable (0-based).
type Var struct{ I int }

// Add is L + R.
type Add struct{ L, R Expr }

// Sub is L - R.
type Sub struct{ L, R Expr }

// Mul is L * R.
type Mul struct{ L, R Expr }

// Div is L / R. It is undefined wherever R is zero (point evaluation)
// or wherever R's interval contains zero (interval evaluation).
type Div struct{ L, R Expr }

// If evaluates Then when Cond holds and Else otherwise. When Cond
// cannot be decided under interval evaluation, both branches are
// evaluated and their results joined.
type If struct {
	Cond       Cond
	Then, Else Expr
}

func (Const) exprNode() {}
func (Var) exprNode()   {}
func (Add) exprNode()   {}
func (Sub) exprNode()   {}
func (Mul) exprNode()   {}
func (Div) exprNode()   {}
func (If) exprNode()    {}

// CmpOp is a comparison operator.
type CmpOp int

const (
	LT CmpOp = iota // <
	LE              // <=
	GT              // >
	GE              // >=
	EQ              // ==
	NE              // !=
)

// Cond compares two expressions.
type Cond struct {
	Op   CmpOp
	L, R Expr
}

// NumVars returns the number of variables referenced by e, i.e. one
// more than the largest variable index (0 if e uses no variables).
func NumVars(e Expr) int {
	switch n := e.(type) {
	case Const:
		return 0
	case Var:
		return n.I + 1
	case Add:
		return max(NumVars(n.L), NumVars(n.R))
	case Sub:
		return max(NumVars(n.L), NumVars(n.R))
	case Mul:
		return max(NumVars(n.L), NumVars(n.R))
	case Div:
		return max(NumVars(n.L), NumVars(n.R))
	case If:
		return max(numVarsCond(n.Cond), max(NumVars(n.Then), NumVars(n.Else)))
	}
	panic("interval: unknown expression node")
}

func numVarsCond(c Cond) int { return max(NumVars(c.L), NumVars(c.R)) }

// value is the result of exact point evaluation.
type value struct {
	r     *big.Rat
	undef bool
}

// Eval evaluates e exactly at the given variable assignment.
// The boolean result reports whether the value is defined.
func Eval(e Expr, env []*big.Rat) (*big.Rat, bool) {
	v := eval(e, env)
	if v.undef {
		return nil, false
	}
	return v.r, true
}

func eval(e Expr, env []*big.Rat) value {
	switch n := e.(type) {
	case Const:
		return value{r: new(big.Rat).Set(n.R)}
	case Var:
		return value{r: new(big.Rat).Set(env[n.I])}
	case Add:
		l, r := eval(n.L, env), eval(n.R, env)
		if l.undef || r.undef {
			return value{undef: true}
		}
		return value{r: new(big.Rat).Add(l.r, r.r)}
	case Sub:
		l, r := eval(n.L, env), eval(n.R, env)
		if l.undef || r.undef {
			return value{undef: true}
		}
		return value{r: new(big.Rat).Sub(l.r, r.r)}
	case Mul:
		l, r := eval(n.L, env), eval(n.R, env)
		if l.undef || r.undef {
			return value{undef: true}
		}
		return value{r: new(big.Rat).Mul(l.r, r.r)}
	case Div:
		l, r := eval(n.L, env), eval(n.R, env)
		if l.undef || r.undef || r.r.Sign() == 0 {
			return value{undef: true}
		}
		return value{r: new(big.Rat).Quo(l.r, r.r)}
	case If:
		ok, undef := evalCond(n.Cond, env)
		if undef {
			return value{undef: true}
		}
		if ok {
			return eval(n.Then, env)
		}
		return eval(n.Else, env)
	}
	panic("interval: unknown expression node")
}

func evalCond(c Cond, env []*big.Rat) (ok, undef bool) {
	l, r := eval(c.L, env), eval(c.R, env)
	if l.undef || r.undef {
		return false, true
	}
	cmp := l.r.Cmp(r.r)
	switch c.Op {
	case LT:
		return cmp < 0, false
	case LE:
		return cmp <= 0, false
	case GT:
		return cmp > 0, false
	case GE:
		return cmp >= 0, false
	case EQ:
		return cmp == 0, false
	case NE:
		return cmp != 0, false
	}
	panic("interval: unknown comparison operator")
}

// iVal is the result of interval evaluation: a hull over the defined
// values plus a flag recording that undefined values may occur.
type iVal struct {
	iv       Interval // valid iff def
	def      bool
	mayUndef bool
}

func join(a, b iVal) iVal {
	out := iVal{def: a.def || b.def, mayUndef: a.mayUndef || b.mayUndef}
	switch {
	case a.def && b.def:
		out.iv = Hull(a.iv, b.iv)
	case a.def:
		out.iv = a.iv
	case b.def:
		out.iv = b.iv
	}
	return out
}

// EvalInterval evaluates e over the given variable domains using
// classical interval arithmetic. The result is sound but may
// overestimate: each occurrence of a variable is treated as
// independent, so shared-variable dependencies are lost. Use
// Enumerate for exact extrema. The returned flag reports whether
// undefined values may occur.
func EvalInterval(e Expr, dom []Interval) (Interval, bool) {
	v := evalInterval(e, dom)
	if !v.def {
		return Undefined(), true
	}
	return v.iv, v.mayUndef
}

func evalInterval(e Expr, dom []Interval) iVal {
	switch n := e.(type) {
	case Const:
		return iVal{iv: Point(n.R), def: true}
	case Var:
		if dom[n.I].Undef {
			return iVal{mayUndef: true}
		}
		return iVal{iv: dom[n.I], def: true}
	case Add:
		return arithInterval(n.L, n.R, dom, Interval.Add)
	case Sub:
		return arithInterval(n.L, n.R, dom, Interval.Sub)
	case Mul:
		return arithInterval(n.L, n.R, dom, Interval.Mul)
	case Div:
		l, r := evalInterval(n.L, dom), evalInterval(n.R, dom)
		out := iVal{mayUndef: l.mayUndef || r.mayUndef}
		if !l.def || !r.def {
			return out
		}
		q := l.iv.Div(r.iv)
		if q.Undef {
			// Divisor interval contains zero: quotient undefined.
			out.mayUndef = true
			return out
		}
		out.iv, out.def = q, true
		return out
	case If:
		tri, condUndef := condInterval(n.Cond, dom)
		switch tri {
		case trueOnly:
			v := evalInterval(n.Then, dom)
			v.mayUndef = v.mayUndef || condUndef
			return v
		case falseOnly:
			v := evalInterval(n.Else, dom)
			v.mayUndef = v.mayUndef || condUndef
			return v
		default: // both branches possible
			v := join(evalInterval(n.Then, dom), evalInterval(n.Else, dom))
			v.mayUndef = v.mayUndef || condUndef
			return v
		}
	}
	panic("interval: unknown expression node")
}

func arithInterval(l, r Expr, dom []Interval, op func(Interval, Interval) Interval) iVal {
	a, b := evalInterval(l, dom), evalInterval(r, dom)
	out := iVal{mayUndef: a.mayUndef || b.mayUndef}
	if a.def && b.def {
		out.iv, out.def = op(a.iv, b.iv), true
	}
	return out
}

type tri int

const (
	falseOnly tri = iota
	trueOnly
	both
)

// condInterval decides a comparison over intervals. It reports both
// when either outcome is reachable, and mayUndef when an operand may
// be undefined.
func condInterval(c Cond, dom []Interval) (tri, bool) {
	l, r := evalInterval(c.L, dom), evalInterval(c.R, dom)
	mayUndef := l.mayUndef || r.mayUndef
	if !l.def || !r.def {
		return both, true
	}
	a, b := l.iv, r.iv
	var t, f bool
	switch c.Op {
	case LT:
		t, f = a.Hi.Cmp(b.Lo) < 0, a.Lo.Cmp(b.Hi) >= 0
	case LE:
		t, f = a.Hi.Cmp(b.Lo) <= 0, a.Lo.Cmp(b.Hi) > 0
	case GT:
		t, f = a.Lo.Cmp(b.Hi) > 0, a.Hi.Cmp(b.Lo) <= 0
	case GE:
		t, f = a.Lo.Cmp(b.Hi) >= 0, a.Hi.Cmp(b.Lo) < 0
	case EQ:
		t = a.Lo.Cmp(a.Hi) == 0 && b.Lo.Cmp(b.Hi) == 0 && a.Lo.Cmp(b.Lo) == 0
		f = a.Hi.Cmp(b.Lo) < 0 || b.Hi.Cmp(a.Lo) < 0
	case NE:
		f = a.Lo.Cmp(a.Hi) == 0 && b.Lo.Cmp(b.Hi) == 0 && a.Lo.Cmp(b.Lo) == 0
		t = a.Hi.Cmp(b.Lo) < 0 || b.Hi.Cmp(a.Lo) < 0
	default:
		panic("interval: unknown comparison operator")
	}
	switch {
	case t:
		return trueOnly, mayUndef
	case f:
		return falseOnly, mayUndef
	default:
		return both, mayUndef
	}
}
