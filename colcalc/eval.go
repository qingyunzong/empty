package colcalc

// Row is one JSON object of the table.
type Row map[string]any

// Program is an expression bound for repeated row-by-row evaluation.
type Program struct{ root Expr }

// Compile binds an expression for evaluation. Evaluation itself happens
// per row in Eval; nothing is inferred from any particular row.
func Compile(e Expr) *Program { return &Program{root: e} }

// Eval evaluates the program against a single row.
func (p *Program) Eval(row Row) Value { return eval(p.root, row) }

// Eval evaluates an expression against a single row.
func Eval(e Expr, row Row) Value { return eval(e, row) }

func eval(e Expr, row Row) Value {
	switch ex := e.(type) {
	case Lit:
		return ex.V
	case Col:
		raw, ok := row[ex.Name]
		if !ok {
			return Missingv()
		}
		return FromJSON(raw)
	case Arith:
		return evalArith(ex, row)
	case Cmp:
		return evalCmp(ex, row)
	case If:
		cond := eval(ex.Cond, row)
		switch {
		case cond.Kind == Bool && cond.B:
			return eval(ex.Then, row)
		case cond.Kind == Bool:
			return eval(ex.Else, row)
		case cond.Kind == Null || cond.Kind == Missing || cond.Kind == Error:
			return cond
		default:
			return Errv("if condition must be bool, got %s", cond.Kind)
		}
	case Logic:
		return evalLogic(ex, row)
	case Not:
		v := eval(ex.E, row)
		if v.Kind == Bool {
			return Boolv(!v.B)
		}
		return propagate1("not", v)
	case Pred:
		v := eval(ex.E, row)
		switch ex.Kind {
		case IsNull:
			return Boolv(v.Kind == Null)
		case IsMissing:
			return Boolv(v.Kind == Missing)
		case IsError:
			return Boolv(v.Kind == Error)
		}
	}
	return Errv("unknown expression %T", e)
}

// propagate1 applies the state precedence error > missing > null for a
// unary operator; concrete values of the wrong type are a type error.
func propagate1(op string, v Value) Value {
	switch v.Kind {
	case Error, Missing, Null:
		return v
	}
	return Errv("%s: bad operand type %s", op, v.Kind)
}

// propagate applies the state precedence error > missing > null to the
// operands of a binary operator. It returns ok=false when a state was
// propagated instead of computing.
func propagate(op string, l, r Value) (Value, bool) {
	if l.Kind == Error {
		return l, false
	}
	if r.Kind == Error {
		return r, false
	}
	if l.Kind == Missing || r.Kind == Missing {
		return Missingv(), false
	}
	if l.Kind == Null || r.Kind == Null {
		return Nullv(), false
	}
	return Value{}, true
}

func evalArith(ex Arith, row Row) Value {
	l, r := eval(ex.L, row), eval(ex.R, row)
	if v, ok := propagate("arith", l, r); !ok {
		return v
	}
	if l.Kind != Number || r.Kind != Number {
		return Errv("arithmetic on %s and %s", l.Kind, r.Kind)
	}
	switch ex.Op {
	case Add:
		return Numv(l.Num + r.Num)
	case Sub:
		return Numv(l.Num - r.Num)
	case Mul:
		return Numv(l.Num * r.Num)
	case Div:
		if r.Num == 0 {
			return Errv("division by zero")
		}
		return Numv(l.Num / r.Num)
	}
	return Errv("unknown arithmetic op")
}

func evalCmp(ex Cmp, row Row) Value {
	l, r := eval(ex.L, row), eval(ex.R, row)
	if v, ok := propagate("cmp", l, r); !ok {
		return v
	}
	if l.Kind != r.Kind {
		return Errv("cannot compare %s with %s", l.Kind, r.Kind)
	}
	switch l.Kind {
	case Number:
		return cmpOrdered(ex.Op, l.Num, r.Num)
	case String:
		return cmpOrdered(ex.Op, l.Str, r.Str)
	case Bool:
		switch ex.Op {
		case Eq:
			return Boolv(l.B == r.B)
		case Ne:
			return Boolv(l.B != r.B)
		}
		return Errv("booleans only support == and !=")
	}
	return Errv("cannot compare kind %s", l.Kind)
}

func cmpOrdered[T float64 | string](op CmpOp, l, r T) Value {
	switch op {
	case Eq:
		return Boolv(l == r)
	case Ne:
		return Boolv(l != r)
	case Lt:
		return Boolv(l < r)
	case Le:
		return Boolv(l <= r)
	case Gt:
		return Boolv(l > r)
	case Ge:
		return Boolv(l >= r)
	}
	return Errv("unknown comparison op")
}

func evalLogic(ex Logic, row Row) Value {
	l := eval(ex.L, row)
	// Short-circuit only on a decisive concrete boolean; states still
	// require the other operand to apply the precedence rules.
	if ex.Op == And && l.Kind == Bool && !l.B {
		return Boolv(false)
	}
	if ex.Op == Or && l.Kind == Bool && l.B {
		return Boolv(true)
	}
	r := eval(ex.R, row)
	if v, ok := propagate("logic", l, r); !ok {
		return v
	}
	if l.Kind != Bool || r.Kind != Bool {
		return Errv("logic on %s and %s", l.Kind, r.Kind)
	}
	if ex.Op == And {
		return Boolv(l.B && r.B)
	}
	return Boolv(l.B || r.B)
}
