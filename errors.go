package dataeng

import "fmt"

// ParseError describes a syntax or semantic error in a configuration
// document. Line and Column are 1-based byte positions.
type ParseError struct {
	Line   int
	Column int
	Msg    string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("line %d, column %d: %s", e.Line, e.Column, e.Msg)
}
