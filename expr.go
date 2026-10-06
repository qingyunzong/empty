package colcalc

import (
	"encoding/json"
	"fmt"
	"math"
)

// Row is one record of a JSON table: a JSON object decoded with
// json.Decoder.UseNumber, so numbers appear as json.Number.
type Row map[string]any

// Expr is a column expression evaluated independently against each row.
type Expr interface {
	Eval(row Row) Cell
}

// Col references a column by name. Absent keys evaluate to the missing
// state and JSON nulls to the null state.
func Col(name string) Expr { return colExpr{name: name} }

// Lit is a constant. Supported values: nil (null cell), bool, string and
// any Go numeric type (normalized to float64).
func Lit(v any) Expr { return litExpr{v: v} }

// If evaluates cond; when it is a concrete bool, only the selected branch
// is evaluated, so errors in the other branch never pollute the result.
// A missing, null or error condition propagates its state.
func If(cond, then, els Expr) Expr { return ifExpr{cond: cond, then: then, els: els} }

// Not negates a boolean operand.
func Not(e Expr) Expr { return unExpr{op: opNot, e: e} }

// Neg negates a numeric operand.
func Neg(e Expr) Expr { return unExpr{op: opNeg, e: e} }

func Add(l, r Expr) Expr { return binExpr{op: opAdd, l: l, r: r} }
func Sub(l, r Expr) Expr { return binExpr{op: opSub, l: l, r: r} }
func Mul(l, r Expr) Expr { return binExpr{op: opMul, l: l, r: r} }
func Div(l, r Expr) Expr { return binExpr{op: opDiv, l: l, r: r} }
func Mod(l, r Expr) Expr { return binExpr{op: opMod, l: l, r: r} }

func Eq(l, r Expr) Expr { return binExpr{op: opEq, l: l, r: r} }
func Ne(l, r Expr) Expr { return binExpr{op: opNe, l: l, r: r} }
func Lt(l, r Expr) Expr { return binExpr{op: opLt, l: l, r: r} }
func Le(l, r Expr) Expr { return binExpr{op: opLe, l: l, r: r} }
func Gt(l, r Expr) Expr { return binExpr{op: opGt, l: l, r: r} }
func Ge(l, r Expr) Expr { return binExpr{op: opGe, l: l, r: r} }

// And and Or use three-valued logic with short-circuiting: a concrete
// false (and) or true (or) decides the result without evaluating the
// other operand; otherwise missing/null propagate as unknown.
func And(l, r Expr) Expr { return binExpr{op: opAnd, l: l, r: r} }
func Or(l, r Expr) Expr  { return binExpr{op: opOr, l: l, r: r} }

type opKind int

const (
	opAdd opKind = iota
	opSub
	opMul
	opDiv
	opMod
	opEq
	opNe
	opLt
	opLe
	opGt
	opGe
	opAnd
	opOr
	opNot
	opNeg
)

func opName(op opKind) string {
	switch op {
	case opAdd:
		return "+"
	case opSub:
		return "-"
	case opMul:
		return "*"
	case opDiv:
		return "/"
	case opMod:
		return "%"
	case opEq:
		return "=="
	case opNe:
		return "!="
	case opLt:
		return "<"
	case opLe:
		return "<="
	case opGt:
		return ">"
	case opGe:
		return ">="
	case opAnd:
		return "and"
	case opOr:
		return "or"
	case opNot:
		return "not"
	case opNeg:
		return "-"
	}
	return "?"
}

func typeName(v any) string {
	switch v.(type) {
	case float64:
		return "number"
	case string:
		return "string"
	case bool:
		return "bool"
	default:
		return fmt.Sprintf("%T", v)
	}
}

type colExpr struct{ name string }

func (c colExpr) Eval(row Row) Cell {
	v, ok := row[c.name]
	if !ok {
		return Missing()
	}
	if v == nil {
		return Null()
	}
	switch t := v.(type) {
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return errorf("column %q: invalid number %q", c.name, t)
		}
		return Value(f)
	case float64:
		return Value(t)
	case int:
		return Value(float64(t))
	case int64:
		return Value(float64(t))
	case string:
		return Value(t)
	case bool:
		return Value(t)
	default:
		return errorf("column %q: unsupported JSON value of type %T", c.name, v)
	}
}

type litExpr struct{ v any }

func (l litExpr) Eval(Row) Cell {
	switch t := l.v.(type) {
	case nil:
		return Null()
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return errorf("invalid number literal %q", t)
		}
		return Value(f)
	case float64, string, bool:
		return Value(t)
	case int:
		return Value(float64(t))
	case int64:
		return Value(float64(t))
	default:
		return errorf("unsupported literal of type %T", l.v)
	}
}

type ifExpr struct{ cond, then, els Expr }

func (i ifExpr) Eval(row Row) Cell {
	c := i.cond.Eval(row)
	if c.State != StateValue {
		return c
	}
	b, ok := c.Value.(bool)
	if !ok {
		return errorf("if: condition must be bool, got %s", typeName(c.Value))
	}
	if b {
		return i.then.Eval(row)
	}
	return i.els.Eval(row)
}

type unExpr struct {
	op opKind
	e  Expr
}

func (u unExpr) Eval(row Row) Cell {
	c := u.e.Eval(row)
	if c.State != StateValue {
		return c
	}
	switch u.op {
	case opNot:
		b, ok := c.Value.(bool)
		if !ok {
			return errorf("not: operand must be bool, got %s", typeName(c.Value))
		}
		return Value(!b)
	case opNeg:
		f, ok := c.Value.(float64)
		if !ok {
			return errorf("negation: operand must be number, got %s", typeName(c.Value))
		}
		return Value(-f)
	}
	return errorf("unknown unary operator")
}

type binExpr struct {
	op   opKind
	l, r Expr
}

func (b binExpr) Eval(row Row) Cell {
	switch b.op {
	case opAnd:
		return evalLogic(b.l, b.r, row, false)
	case opOr:
		return evalLogic(b.l, b.r, row, true)
	}
	l := b.l.Eval(row)
	r := b.r.Eval(row)
	if bad := propagate(l, r); bad.State != StateValue {
		return bad
	}
	switch b.op {
	case opAdd, opSub, opMul, opDiv, opMod:
		return arith(b.op, l.Value, r.Value)
	default:
		return compare(b.op, l.Value, r.Value)
	}
}

// propagate returns the highest-priority non-value cell, with priority
// error > missing > null, or a zero value cell when all inputs hold values.
func propagate(cells ...Cell) Cell {
	best := Cell{}
	bestPri := 0
	for _, c := range cells {
		pri := 0
		switch c.State {
		case StateError:
			pri = 3
		case StateMissing:
			pri = 2
		case StateNull:
			pri = 1
		}
		if pri > bestPri {
			best, bestPri = c, pri
		}
	}
	return best
}

// evalLogic implements short-circuiting three-valued and/or. isOr selects
// the operator: or short-circuits on true, and on false.
func evalLogic(le, re Expr, row Row, isOr bool) Cell {
	name := "and"
	if isOr {
		name = "or"
	}
	l := le.Eval(row)
	if l.State == StateError {
		return l
	}
	if l.State == StateValue {
		lb, ok := l.Value.(bool)
		if !ok {
			return errorf("%s: operand must be bool, got %s", name, typeName(l.Value))
		}
		if lb == isOr {
			return Value(isOr) // short-circuit: decisive value, skip right side
		}
	}
	r := re.Eval(row)
	if r.State == StateError {
		return r
	}
	if r.State == StateValue {
		rb, ok := r.Value.(bool)
		if !ok {
			return errorf("%s: operand must be bool, got %s", name, typeName(r.Value))
		}
		if l.State != StateValue {
			if rb == isOr {
				return Value(isOr) // unknown and false -> false; unknown or true -> true
			}
			return l // unknown stays unknown
		}
		return Value(rb)
	}
	// r is missing or null.
	if l.State == StateValue {
		return r
	}
	if l.State == StateMissing {
		return l // missing dominates null
	}
	return r
}

func arith(op opKind, lv, rv any) Cell {
	if op == opAdd {
		if ls, ok := lv.(string); ok {
			if rs, ok := rv.(string); ok {
				return Value(ls + rs)
			}
		}
	}
	lf, lok := lv.(float64)
	rf, rok := rv.(float64)
	if !lok || !rok {
		return errorf("%s: cannot apply to %s and %s", opName(op), typeName(lv), typeName(rv))
	}
	switch op {
	case opAdd:
		return Value(lf + rf)
	case opSub:
		return Value(lf - rf)
	case opMul:
		return Value(lf * rf)
	case opDiv:
		if rf == 0 {
			return errorf("division by zero")
		}
		return Value(lf / rf)
	case opMod:
		if rf == 0 {
			return errorf("modulo by zero")
		}
		return Value(math.Mod(lf, rf))
	}
	return errorf("unknown arithmetic operator")
}

func compare(op opKind, lv, rv any) Cell {
	if op == opEq || op == opNe {
		eq := valuesEqual(lv, rv)
		if op == opNe {
			eq = !eq
		}
		return Value(eq)
	}
	if lf, ok := lv.(float64); ok {
		if rf, ok := rv.(float64); ok {
			return Value(order(op, lf < rf, lf == rf))
		}
	}
	if ls, ok := lv.(string); ok {
		if rs, ok := rv.(string); ok {
			return Value(order(op, ls < rs, ls == rs))
		}
	}
	return errorf("%s: cannot compare %s and %s", opName(op), typeName(lv), typeName(rv))
}

func order(op opKind, less, equal bool) bool {
	switch op {
	case opLt:
		return less
	case opLe:
		return less || equal
	case opGt:
		return !less && !equal
	case opGe:
		return !less || equal
	}
	return false
}

func valuesEqual(lv, rv any) bool {
	switch l := lv.(type) {
	case float64:
		r, ok := rv.(float64)
		return ok && l == r
	case string:
		r, ok := rv.(string)
		return ok && l == r
	case bool:
		r, ok := rv.(bool)
		return ok && l == r
	}
	return false
}
