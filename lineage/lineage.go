// Package lineage re-exports the polynomial lineage API from the module root.
// It exists so query hosts can import a package named lineage while sharing
// the same Expr, Polynomial, and error values.
package lineage

import dataeng "example.org/dataeng/q0111"

type (
	Expr                 = dataeng.Expr
	Kind                 = dataeng.Kind
	Polynomial           = dataeng.Polynomial
	Term                 = dataeng.Term
	Options              = dataeng.Options
	BudgetError          = dataeng.BudgetError
	MissingVariableError = dataeng.MissingVariableError
)

const (
	Unlimited = dataeng.Unlimited

	KindInvalid = dataeng.KindInvalid
	KindVar     = dataeng.KindVar
	KindUnion   = dataeng.KindUnion
	KindJoin    = dataeng.KindJoin
	KindZero    = dataeng.KindZero
	KindOne     = dataeng.KindOne
)

var (
	ErrEmptyVariableID  = dataeng.ErrEmptyVariableID
	ErrInvalidUTF8      = dataeng.ErrInvalidUTF8
	ErrNilExpression    = dataeng.ErrNilExpression
	ErrCycle            = dataeng.ErrCycle
	ErrInvalidBudget    = dataeng.ErrInvalidBudget
	ErrExponentOverflow = dataeng.ErrExponentOverflow
	ErrBudgetExceeded   = dataeng.ErrBudgetExceeded
)

var (
	ValidateVariableID = dataeng.ValidateVariableID
	NewVar             = dataeng.NewVar
	Var                = dataeng.Var
	MustVar            = dataeng.MustVar
	Variable           = dataeng.Variable
	Zero               = dataeng.Zero
	One                = dataeng.One
	NewUnion           = dataeng.NewUnion
	Union              = dataeng.Union
	UnionAll           = dataeng.UnionAll
	Add                = dataeng.Add
	Sum                = dataeng.Sum
	NewJoin            = dataeng.NewJoin
	Join               = dataeng.Join
	JoinAll            = dataeng.JoinAll
	Multiply           = dataeng.Multiply
	Product            = dataeng.Product
	Validate           = dataeng.Validate
	Variables          = dataeng.Variables
	Compile            = dataeng.Compile
	CompileOptions     = dataeng.CompileOptions
	CompileWithBudget  = dataeng.CompileWithBudget
	Eval               = dataeng.Eval
	EvalUnlimited      = dataeng.EvalUnlimited
	Expand             = dataeng.Expand
	ToPolynomial       = dataeng.ToPolynomial
	CompareExponents   = dataeng.CompareExponents
	SortVariableIDs    = dataeng.SortVariableIDs
)
