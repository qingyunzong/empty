package dataeng

import "errors"

var (
	// ErrInvalidConfig reports an invalid cell count, seed list, scheme ID,
	// or missing host hash function.
	ErrInvalidConfig = errors.New("dataeng: invalid IBLT configuration")

	// ErrInvalidHashOutput reports a host hash function that returned the
	// wrong number of indices, duplicate indices, or an out-of-range index.
	ErrInvalidHashOutput = errors.New("dataeng: invalid host hash output")

	// ErrConfigMismatch reports subtraction or resumption against a table
	// whose configuration is not identical.
	ErrConfigMismatch = errors.New("dataeng: table configurations differ")

	// ErrDuplicateID reports a repeated identifier in an input set snapshot.
	ErrDuplicateID = errors.New("dataeng: duplicate identifier in set snapshot")

	// ErrInvalidBudget reports a non-positive peel step budget.
	ErrInvalidBudget = errors.New("dataeng: step budget must be positive")

	// ErrResumeMismatch reports a paused state that is internally inconsistent
	// or that is not bound to the supplied difference table.
	ErrResumeMismatch = errors.New("dataeng: paused state does not match")

	// ErrInternalState reports an impossible state detected by the package.
	ErrInternalState = errors.New("dataeng: inconsistent internal peel state")
)
