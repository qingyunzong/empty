package dataeng

import "fmt"

// atom is a resolved value operand: either a dictionary-encoded column
// reference or a typed literal. null is represented separately, so no value
// is ever decoded through an interface.
type atom struct {
	isColumn bool
	colType  ColumnType
	name     string
	intVal   int64
	strVal   string
	null     bool
}

// boolPlan is a compiled, schema-bound boolean expression. Plans are
// immutable after Compile returns and hold no per-evaluation state, so the
// same *Expr can be evaluated concurrently.
type boolPlan interface {
	eval(b *Batch, rows int) *triVec
}

type atomPlan interface {
	atom() atom
}

type columnPlan struct{ at atom }
type literalPlan struct{ at atom }

func (p columnPlan) atom() atom  { return p.at }
func (p literalPlan) atom() atom { return p.at }

type cmpPlan struct {
	op    CmpOp
	left  atomPlan
	right atomPlan
}

type isNullPlan struct{ value atomPlan }
type notPlan struct{ inner boolPlan }
type andPlan struct{ left, right boolPlan }
type orPlan struct{ left, right boolPlan }

// Compile parses and type-checks source against schema, rejecting unknown
// columns and any expression that mixes int64 and string values without an
// explicit conversion (no implicit conversions exist).
func Compile(schema Schema, source string) (*Expr, error) {
	root, err := Parse(source)
	if err != nil {
		return nil, err
	}
	plan, err := checkBool(schema, root)
	if err != nil {
		return nil, err
	}
	return &Expr{plan: plan, schema: schema}, nil
}

func checkBool(schema Schema, node Node) (boolPlan, error) {
	expr, ok := node.(*BoolExpr)
	if !ok {
		return nil, fmt.Errorf("%w: top-level expression must be boolean, got a value",
			ErrTypeMismatch)
	}
	switch expr.Op {
	case "and":
		left, err := checkBool(schema, expr.Left)
		if err != nil {
			return nil, err
		}
		right, err := checkBool(schema, expr.Right)
		if err != nil {
			return nil, err
		}
		return andPlan{left: left, right: right}, nil
	case "or":
		left, err := checkBool(schema, expr.Left)
		if err != nil {
			return nil, err
		}
		right, err := checkBool(schema, expr.Right)
		if err != nil {
			return nil, err
		}
		return orPlan{left: left, right: right}, nil
	case "not":
		inner, err := checkBool(schema, expr.Left)
		if err != nil {
			return nil, err
		}
		return notPlan{inner: inner}, nil
	case "isnull":
		value, err := checkValue(schema, expr.Left)
		if err != nil {
			return nil, err
		}
		return isNullPlan{value: value}, nil
	case "cmp":
		left, err := checkValue(schema, expr.Left)
		if err != nil {
			return nil, err
		}
		right, err := checkValue(schema, expr.Right)
		if err != nil {
			return nil, err
		}
		lat := left.atom()
		rat := right.atom()
		if !lat.null && !rat.null && lat.colType != rat.colType {
			return nil, fmt.Errorf("%w: cannot compare %s and %s with %s",
				ErrTypeMismatch, lat.colType, rat.colType, expr.Cmp)
		}
		return cmpPlan{op: expr.Cmp, left: left, right: right}, nil
	default:
		return nil, fmt.Errorf("%w: unsupported boolean operator %q", ErrSyntax, expr.Op)
	}
}

func checkValue(schema Schema, node Node) (atomPlan, error) {
	value, ok := node.(*ValueExpr)
	if !ok {
		return nil, fmt.Errorf("%w: expected value operand, got boolean expression",
			ErrTypeMismatch)
	}
	if value.IsColumn {
		colType, ok := schema.Columns[value.Column]
		if !ok {
			return nil, fmt.Errorf("%w: column %q is not declared in the schema",
				ErrUnknownColumn, value.Column)
		}
		return columnPlan{at: atom{isColumn: true, colType: colType, name: value.Column}}, nil
	}
	return literalPlan{at: atom{
		colType: value.Type,
		intVal:  value.IntVal,
		strVal:  value.StrVal,
		null:    value.IsNull,
	}}, nil
}
