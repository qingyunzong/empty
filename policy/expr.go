// Package policy compiles declarative admission-control rules into
// reusable, immutable evaluation plans.
//
// A Rule is a deny rule: when its When expression matches an object, the
// rule rejects the object and contributes a Reason. A decision is allowed
// only when no rule matches ("any deny rejects the whole").
//
// Semantics highlights:
//   - Field resolution is tri-state: a path may be Missing, explicitly
//     Null, or hold a Value. Predicates distinguish all three.
//   - Quantifiers: ForAll over an empty collection is vacuously true,
//     Exists over an empty collection is false. Quantifying over a
//     missing, null, or non-list path yields false for both kinds.
//   - Evaluation is pure: it never mutates the object or the plan, so
//     short-circuit evaluation has no observable side effects.
package policy

// Expr is a declarative boolean expression node (the rule AST).
// Concrete types: And, Or, Not, Pred, Selector, Quantifier.
type Expr interface{ exprNode() }

// And is true when every argument is true. And with no args is true.
type And struct{ Args []Expr }

// Or is true when at least one argument is true. Or with no args is false.
type Or struct{ Args []Expr }

// Not negates its argument.
type Not struct{ Arg Expr }

func (And) exprNode() {}
func (Or) exprNode()  {}
func (Not) exprNode() {}

// Op is a field predicate operator.
type Op int

const (
	OpEq    Op = iota // field == Value (numeric coercion applied)
	OpNotEq           // field != Value; false when the field is missing
	OpIn              // field ∈ Value (Value must be a list)
	OpNotIn           // field ∉ Value; false when the field is missing
	OpGt              // numeric/string ordering comparisons;
	OpGte             // false when the field is missing or null
	OpLt
	OpLte
	OpExists    // path resolves to a value or an explicit null
	OpNotExists // path is missing
	OpIsNull    // path is present and explicitly null
	OpIsNotNull // path resolves to a non-null value
	OpMatches   // string field matches regexp Value
)

func (op Op) valid() bool { return op >= OpEq && op <= OpMatches }

// Pred is a predicate on a nested field of the evaluated object.
// Path is a list of map keys walked from the object root; an empty path
// refers to the object itself. Inside a Quantifier item expression the
// path is relative to the current item.
type Pred struct {
	Path  []string
	Op    Op
	Value any
}

func (Pred) exprNode() {}

// SelectorOp is a label-selector requirement operator, mirroring the
// Kubernetes label selector semantics.
type SelectorOp int

const (
	SelectorIn SelectorOp = iota
	SelectorNotIn
	SelectorExists
	SelectorDoesNotExist
)

// SelectorExpr is one requirement of a label Selector.
type SelectorExpr struct {
	Key      string
	Operator SelectorOp
	Values   []string // used by SelectorIn / SelectorNotIn
}

// Selector matches a string map (labels) reached at Path. A nil Path
// defaults to ["metadata", "labels"]. An empty Selector matches
// everything, including a missing labels map.
type Selector struct {
	Path             []string
	MatchLabels      map[string]string
	MatchExpressions []SelectorExpr
}

func (Selector) exprNode() {}

// QuantKind selects the quantifier semantics.
type QuantKind int

const (
	// ForAll is true when Item holds for every element; vacuously true
	// on an empty collection.
	ForAll QuantKind = iota
	// Exists is true when Item holds for at least one element; false on
	// an empty collection.
	Exists
)

// Quantifier applies Item to each element of the list found at Path.
// A missing, null, or non-list Path makes the quantifier false
// (for both kinds); an empty list keeps the vacuous truth table above.
type Quantifier struct {
	Kind QuantKind
	Path []string
	Item Expr
}

func (Quantifier) exprNode() {}

// Rule is a single declarative deny rule.
type Rule struct {
	// ID is the stable rule identifier. It must be unique within a
	// rule set and is carried into every Reason the rule produces.
	ID string
	// When, if it matches the object, makes this rule reject it.
	When Expr
	// Reason is a human-readable message; a default is used if empty.
	Reason string
}

// Reason explains why a rule rejected an object.
type Reason struct {
	RuleID  string
	Message string
}

// Decision is the outcome of evaluating a plan against an object.
type Decision struct {
	// Allowed is true when no rule matched.
	Allowed bool
	// Reasons lists every matched rule in stable rule order (the order
	// rules were given at compile time). Under short-circuit
	// evaluation it contains at most the first matched rule.
	Reasons []Reason
}
