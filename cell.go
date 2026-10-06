// Package colcalc evaluates arithmetic, comparison and conditional
// expressions over the columns of a JSON table.
//
// Every computed cell carries one of three independent non-value states:
// missing (the column is absent from the row), null (the column holds a
// JSON null) and error (evaluation failed). The states never collapse
// into each other: a missing operand yields a missing result, a null
// operand yields a null result, and only a genuine failure yields an
// error.
//
// Expressions are interpreted row by row. The type of every operand is
// resolved from the value found in the current row, never inferred from
// the first row of the table, so a column that mixes numbers, strings,
// nulls and absent keys is evaluated correctly per row.
//
// Conditionals are lazy: If evaluates only the selected branch, so an
// error in the unselected branch cannot pollute the result.
package colcalc

import (
	"fmt"
	"strconv"
)

// State is the evaluation state of a single result cell.
type State int

const (
	// StateValue means the cell holds a concrete value (float64, string or bool).
	StateValue State = iota
	// StateMissing means a referenced column is absent from the row.
	StateMissing
	// StateNull means a referenced column holds a JSON null.
	StateNull
	// StateError means evaluation failed; Err carries the cause.
	StateError
)

func (s State) String() string {
	switch s {
	case StateValue:
		return "value"
	case StateMissing:
		return "missing"
	case StateNull:
		return "null"
	case StateError:
		return "error"
	}
	return "unknown"
}

// Cell is the result of evaluating an expression against one row.
type Cell struct {
	State State
	Value any   // valid when State == StateValue: float64, string or bool
	Err   error // valid when State == StateError
}

// Value returns a cell holding a concrete value.
func Value(v any) Cell { return Cell{State: StateValue, Value: v} }

// Missing returns a cell in the missing state.
func Missing() Cell { return Cell{State: StateMissing} }

// Null returns a cell in the null state.
func Null() Cell { return Cell{State: StateNull} }

// Error returns a cell in the error state.
func Error(err error) Cell { return Cell{State: StateError, Err: err} }

func errorf(format string, args ...any) Cell {
	return Error(fmt.Errorf(format, args...))
}

func (c Cell) String() string {
	switch c.State {
	case StateValue:
		if f, ok := c.Value.(float64); ok {
			return strconv.FormatFloat(f, 'g', -1, 64)
		}
		return fmt.Sprintf("%v", c.Value)
	case StateMissing:
		return "<missing>"
	case StateNull:
		return "<null>"
	case StateError:
		return "<error: " + c.Err.Error() + ">"
	}
	return "<?>"
}
