package dataeng

import "errors"

// Sentinel errors returned by the package. All concrete errors returned by
// Compile and Expr.Evaluate wrap one of these values, so callers can use
// errors.Is to classify failures.
var (
	// ErrInvalidBatch indicates that a batch failed structural validation:
	// a missing or mistyped column, a wrong number of row indices, or an
	// index outside the dictionary range. The whole batch is rejected.
	ErrInvalidBatch = errors.New("dataeng: invalid batch")

	// ErrSyntax indicates that the predicate source cannot be parsed.
	ErrSyntax = errors.New("dataeng: syntax error")

	// ErrUnknownColumn indicates that the predicate references a column that
	// is not declared in the schema.
	ErrUnknownColumn = errors.New("dataeng: unknown column")

	// ErrTypeMismatch indicates that operands have incompatible types. The
	// language has no implicit conversions, so e.g. comparing an int64 value
	// against a string value is rejected at compile time.
	ErrTypeMismatch = errors.New("dataeng: type mismatch")
)
