package dataeng

import (
	"errors"
	"fmt"
)

// Unlimited disables the monomial limit for polynomial expansion.
const Unlimited = -1

var (
	// ErrEmptyVariableID is returned when a variable ID is empty.
	ErrEmptyVariableID = errors.New("dataeng: variable ID must not be empty")

	// ErrInvalidUTF8 is returned when a variable ID is not valid UTF-8.
	ErrInvalidUTF8 = errors.New("dataeng: variable ID is not valid UTF-8")

	// ErrNilExpression is returned when an expression or child expression is nil.
	ErrNilExpression = errors.New("dataeng: nil expression")

	// ErrCycle is returned when the expression graph contains a cycle.
	ErrCycle = errors.New("dataeng: expression graph contains a cycle")

	// ErrInvalidBudget is returned when a monomial budget is invalid.
	ErrInvalidBudget = errors.New("dataeng: monomial budget must be non-negative or Unlimited")

	// ErrExponentOverflow is returned when an exponent cannot be represented.
	ErrExponentOverflow = errors.New("dataeng: exponent overflow")

	// ErrBudgetExceeded is returned when a polynomial has more monomials than
	// the supplied budget. No truncated polynomial is returned in that case.
	ErrBudgetExceeded = errors.New("dataeng: monomial budget unclosed")
)

// BudgetError reports a closed monomial budget violation. The expansion is
// unclosed: it is not truncated to Limit even though more terms were observed.
type BudgetError struct {
	Limit    int
	Observed int
}

func (e *BudgetError) Error() string {
	return fmt.Sprintf("%s: observed %d monomials, limit %d", ErrBudgetExceeded, e.Observed, e.Limit)
}

// Is lets callers use errors.Is(err, ErrBudgetExceeded).
func (e *BudgetError) Is(target error) bool {
	return target == ErrBudgetExceeded
}

// MissingVariableError reports an unassigned variable during evaluation.
type MissingVariableError struct {
	ID string
}

func (e *MissingVariableError) Error() string {
	return fmt.Sprintf("dataeng: no value assigned to variable %q", e.ID)
}
