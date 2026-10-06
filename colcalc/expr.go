package colcalc

// Expr is a column expression evaluated independently against each row.
type Expr interface{ isExpr() }

type Lit struct{ V Value }
type Col struct{ Name string }

type ArithOp int

const (
	Add ArithOp = iota
	Sub
	Mul
	Div
)

type Arith struct {
	Op   ArithOp
	L, R Expr
}

type CmpOp int

const (
	Eq CmpOp = iota
	Ne
	Lt
	Le
	Gt
	Ge
)

type Cmp struct {
	Op   CmpOp
	L, R Expr
}

// If evaluates only the selected branch: Cond first, then Then when
// Cond is true, Else when false. The unselected branch is never
// evaluated, so its errors, missing keys or nulls cannot pollute the
// result.
type If struct {
	Cond, Then, Else Expr
}

type LogicOp int

const (
	And LogicOp = iota
	Or
)

type Logic struct {
	Op   LogicOp
	L, R Expr
}

type Not struct{ E Expr }

// State predicates expose the three states to expressions.
type PredKind int

const (
	IsNull PredKind = iota
	IsMissing
	IsError
)

type Pred struct {
	Kind PredKind
	E    Expr
}

func (Lit) isExpr()   {}
func (Col) isExpr()   {}
func (Arith) isExpr() {}
func (Cmp) isExpr()   {}
func (If) isExpr()    {}
func (Logic) isExpr() {}
func (Not) isExpr()   {}
func (Pred) isExpr()  {}
