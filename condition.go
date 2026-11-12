package dataeng

import (
	"fmt"
)

// Truth is the three-valued result of a predicate. A Truth with Valid set to
// false represents SQL NULL. NULL predicates are not true and therefore never
// select a branch.
type Truth struct {
	Valid bool
	Value bool
}

// TruthOf returns a non-null boolean Truth.
func TruthOf(value bool) Truth {
	return Truth{Valid: true, Value: value}
}

// NullTruth returns the NULL predicate value.
func NullTruth() Truth {
	return Truth{}
}

// IsNull reports whether the predicate result is NULL.
func (t Truth) IsNull() bool {
	return !t.Valid
}

// IsTrue reports whether the predicate result is true (neither false nor NULL).
func (t Truth) IsTrue() bool {
	return t.Valid && t.Value
}

// IsFalse reports whether the predicate result is false or NULL.
func (t Truth) IsFalse() bool {
	return !t.IsTrue()
}

// PredicateFunc evaluates one predicate for one row. Returning a NULL Truth
// means the row did not match this branch.
type PredicateFunc func(row int) (Truth, error)

// ValueFunc evaluates one value expression for one row. A nil value, with a
// nil error, represents SQL NULL.
type ValueFunc func(row int) (any, error)

// Predicate is a caller-injected predicate expression. Name is used only for
// access reporting. A nil Eval is treated as a constant NULL predicate.
type Predicate struct {
	Name string
	Eval PredicateFunc
}

// Value is a caller-injected value expression. Name is used only for access
// reporting. A nil Eval is treated as a constant NULL value.
type Value struct {
	Name string
	Eval ValueFunc
}

// Branch is one IF/THEN arm. Predicates and values are evaluated lazily and
// only for rows that have not already matched (or failed) an earlier branch.
type Branch struct {
	Name      string
	Predicate Predicate
	Value     Value
}

// Stage identifies the expression that produced a row error.
type Stage string

const (
	StagePredicate Stage = "predicate"
	StageValue     Stage = "value"
	StageElse      Stage = "else"
)

// ExpressionKind identifies the kind of expression recorded in an Access.
type ExpressionKind string

const (
	KindPredicate ExpressionKind = "predicate"
	KindValue     ExpressionKind = "value"
	KindElse      ExpressionKind = "else"
)

// NoBranch is the branch number used when no ELSE expression exists and no IF
// arm matched a row.
const NoBranch = -1

// RowError records a fault for exactly one row. Other rows are unaffected.
type RowError struct {
	Position   int
	Row        int
	Branch     int
	Stage      Stage
	Expression string
	Cause      error
}

// Error implements error.
func (e *RowError) Error() string {
	name := e.Expression
	if name == "" {
		name = fmt.Sprintf("branch %d", e.Branch)
	}
	return fmt.Sprintf("row %d (%s in %s): %v", e.Row, name, e.Stage, e.Cause)
}

// Unwrap exposes the injected expression error.
func (e *RowError) Unwrap() error {
	return e.Cause
}

// RowResult is the outcome for one input row position. A failed row has Err
// set and is never passed to a later branch. Null and Value report the
// successful value, if any.
type RowResult struct {
	Position int
	Row      int
	Value    any
	Null     bool
	Branch   int
	Stage    Stage
	Err      error
}

// OK reports whether the row completed without an expression error.
func (r RowResult) OK() bool {
	return r.Err == nil
}

// Access is the set of rows actually visited by one expression occurrence.
// Rows are listed in input order, so an expression that was never reached has
// an empty Rows slice. Branch is len(Branches) for an ELSE expression.
type Access struct {
	Branch int
	Kind   ExpressionKind
	Name   string
	Rows   []int
}

// Count returns the number of row visits recorded for the expression.
func (a Access) Count() int {
	return len(a.Rows)
}

// Result contains one result per input row position and one access log per
// expression occurrence. Rows are always in the same order as the input row
// numbers; they are never compacted around failed rows.
type Result struct {
	Rows     []RowResult
	Accesses []Access
}

// Values returns the value for every input position in input order. Failed
// rows and NULL rows have a nil value. Use Errors or Rows to distinguish them.
func (r Result) Values() []any {
	values := make([]any, len(r.Rows))
	for i, row := range r.Rows {
		values[i] = row.Value
	}
	return values
}

// Errors returns an error for every input position in input order. Positions
// that completed successfully have a nil error.
func (r Result) Errors() []error {
	errs := make([]error, len(r.Rows))
	for i, row := range r.Rows {
		errs[i] = row.Err
	}
	return errs
}

// HasErrors reports whether any row failed.
func (r Result) HasErrors() bool {
	for _, row := range r.Rows {
		if row.Err != nil {
			return true
		}
	}
	return false
}

// AccessFor returns the access log for a branch expression occurrence.
func (r Result) AccessFor(branch int, kind ExpressionKind) (Access, bool) {
	for _, access := range r.Accesses {
		if access.Branch == branch && access.Kind == kind {
			return access, true
		}
	}
	return Access{}, false
}

// Evaluate runs an IF chain over the supplied sparse row numbers. Each input
// position is evaluated independently and results retain the exact input
// order.
//
// For every branch, only rows still unresolved after earlier branches have
// their predicate evaluated. A true predicate selects the branch and evaluates
// its value; false and NULL predicates leave the row unresolved. A value or
// predicate error finalizes that row immediately, so a failed row is never
// offered to a later predicate or value. A nil elseValue means every row that
// remains unresolved becomes NULL without touching another expression.
func Evaluate(rows []int, branches []Branch, elseValue Value) Result {
	result := Result{
		Rows:     make([]RowResult, len(rows)),
		Accesses: make([]Access, 0, 2*len(branches)+1),
	}

	predicateAccesses := make([]int, len(branches))
	valueAccesses := make([]int, len(branches))
	for branchIndex, branch := range branches {
		predicateAccesses[branchIndex] = len(result.Accesses)
		result.Accesses = append(result.Accesses, Access{
			Branch: branchIndex,
			Kind:   KindPredicate,
			Name:   expressionName(branch.Predicate.Name, "predicate", branchIndex, branch.Name),
		})
		valueAccesses[branchIndex] = len(result.Accesses)
		result.Accesses = append(result.Accesses, Access{
			Branch: branchIndex,
			Kind:   KindValue,
			Name:   expressionName(branch.Value.Name, "value", branchIndex, branch.Name),
		})
	}

	hasElse := elseValue.Eval != nil
	elseAccess := -1
	if hasElse {
		elseAccess = len(result.Accesses)
		result.Accesses = append(result.Accesses, Access{
			Branch: len(branches),
			Kind:   KindElse,
			Name:   expressionName(elseValue.Name, "else", len(branches), ""),
		})
	}

	active := make([]int, len(rows))
	for position, row := range rows {
		result.Rows[position] = RowResult{
			Position: position,
			Row:      row,
			Branch:   NoBranch,
			Null:     true,
		}
		active[position] = position
	}

	for branchIndex, branch := range branches {
		if len(active) == 0 {
			break
		}

		remaining := active[:0]
		for _, position := range active {
			row := rows[position]

			truth := NullTruth()
			if branch.Predicate.Eval != nil {
				result.Accesses[predicateAccesses[branchIndex]].Rows = append(
					result.Accesses[predicateAccesses[branchIndex]].Rows, row,
				)
				var err error
				truth, err = branch.Predicate.Eval(row)
				if err != nil {
					result.Rows[position].Branch = branchIndex
					result.Rows[position].Stage = StagePredicate
					result.Rows[position].Err = newRowError(
						position, row, branchIndex, StagePredicate,
						result.Accesses[predicateAccesses[branchIndex]].Name, err,
					)
					continue
				}
			}

			if !truth.IsTrue() {
				remaining = append(remaining, position)
				continue
			}

			var value any
			if branch.Value.Eval != nil {
				result.Accesses[valueAccesses[branchIndex]].Rows = append(
					result.Accesses[valueAccesses[branchIndex]].Rows, row,
				)
				var err error
				value, err = branch.Value.Eval(row)
				if err != nil {
					result.Rows[position].Branch = branchIndex
					result.Rows[position].Stage = StageValue
					result.Rows[position].Err = newRowError(
						position, row, branchIndex, StageValue,
						result.Accesses[valueAccesses[branchIndex]].Name, err,
					)
					continue
				}
			}

			result.Rows[position].Value = value
			result.Rows[position].Null = value == nil
			result.Rows[position].Branch = branchIndex
		}
		active = remaining
	}

	if len(active) == 0 {
		return result
	}

	if !hasElse {
		return result
	}

	for _, position := range active {
		row := rows[position]
		result.Accesses[elseAccess].Rows = append(result.Accesses[elseAccess].Rows, row)
		value, err := elseValue.Eval(row)
		if err != nil {
			result.Rows[position].Branch = len(branches)
			result.Rows[position].Stage = StageElse
			result.Rows[position].Err = newRowError(
				position, row, len(branches), StageElse,
				result.Accesses[elseAccess].Name, err,
			)
			continue
		}
		result.Rows[position].Value = value
		result.Rows[position].Null = value == nil
		result.Rows[position].Branch = len(branches)
	}

	return result
}

func expressionName(name, kind string, branch int, branchName string) string {
	if name != "" {
		return name
	}
	if branchName != "" {
		return fmt.Sprintf("branch[%d].%s(%s)", branch, kind, branchName)
	}
	return fmt.Sprintf("branch[%d].%s", branch, kind)
}

func newRowError(position, row, branch int, stage Stage, expression string, cause error) *RowError {
	return &RowError{
		Position:   position,
		Row:        row,
		Branch:     branch,
		Stage:      stage,
		Expression: expression,
		Cause:      cause,
	}
}
