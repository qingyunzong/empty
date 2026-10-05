package dagcalc

// Expr is an integer expression evaluated against an environment of
// named int64 values (inputs and other metrics). Evaluation reports
// the set of names actually read, so conditionals only depend on the
// branch that was taken.
type Expr interface {
	eval(env map[string]int64, used map[string]bool) int64
	staticDeps(out map[string]bool)
}

type constExpr int64

// Const returns an expression with a constant integer value.
func Const(v int64) Expr { return constExpr(v) }

func (c constExpr) eval(_ map[string]int64, _ map[string]bool) int64 { return int64(c) }
func (c constExpr) staticDeps(map[string]bool)                       {}

type refExpr string

// Ref returns an expression reading the named input or metric.
// Unknown names resolve to implicit zero-valued inputs.
func Ref(name string) Expr { return refExpr(name) }

func (r refExpr) eval(env map[string]int64, used map[string]bool) int64 {
	if used != nil {
		used[string(r)] = true
	}
	return env[string(r)]
}
func (r refExpr) staticDeps(out map[string]bool) { out[string(r)] = true }

type binOp int

const (
	opAdd binOp = iota
	opSub
	opMul
	opGt
	opLt
	opEq
)

type binExpr struct {
	op    binOp
	left  Expr
	right Expr
}

// Add returns left + right.
func Add(left, right Expr) Expr { return binExpr{opAdd, left, right} }

// Sub returns left - right.
func Sub(left, right Expr) Expr { return binExpr{opSub, left, right} }

// Mul returns left * right.
func Mul(left, right Expr) Expr { return binExpr{opMul, left, right} }

// Gt returns 1 if left > right, else 0.
func Gt(left, right Expr) Expr { return binExpr{opGt, left, right} }

// Lt returns 1 if left < right, else 0.
func Lt(left, right Expr) Expr { return binExpr{opLt, left, right} }

// Eq returns 1 if left == right, else 0.
func Eq(left, right Expr) Expr { return binExpr{opEq, left, right} }

func (b binExpr) eval(env map[string]int64, used map[string]bool) int64 {
	l := b.left.eval(env, used)
	r := b.right.eval(env, used)
	switch b.op {
	case opAdd:
		return l + r
	case opSub:
		return l - r
	case opMul:
		return l * r
	case opGt:
		if l > r {
			return 1
		}
	case opLt:
		if l < r {
			return 1
		}
	case opEq:
		if l == r {
			return 1
		}
	}
	return 0
}

func (b binExpr) staticDeps(out map[string]bool) {
	b.left.staticDeps(out)
	b.right.staticDeps(out)
}

type ifExpr struct {
	cond Expr
	then Expr
	els  Expr
}

// If returns then when cond evaluates to a non-zero value, else els.
// Only the selected branch is evaluated, so the metric's active
// dependencies exclude the untaken branch.
func If(cond, then, els Expr) Expr { return ifExpr{cond, then, els} }

func (i ifExpr) eval(env map[string]int64, used map[string]bool) int64 {
	if i.cond.eval(env, used) != 0 {
		return i.then.eval(env, used)
	}
	return i.els.eval(env, used)
}

func (i ifExpr) staticDeps(out map[string]bool) {
	i.cond.staticDeps(out)
	i.then.staticDeps(out)
	i.els.staticDeps(out)
}
