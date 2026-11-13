package dataeng

import (
	"errors"
	"fmt"
)

var (
	// ErrInvalidWindowSpec marks an unusable tumbling, sliding, or session spec.
	ErrInvalidWindowSpec = errors.New("dataeng: invalid window specification")
	// ErrInvalidConfig marks an invalid operator configuration.
	ErrInvalidConfig = errors.New("dataeng: invalid configuration")
	// ErrNilOperator is returned when a method is called on a nil Operator.
	ErrNilOperator = errors.New("dataeng: nil operator")
	// ErrSnapshotFormat marks a snapshot that cannot be decoded by this version.
	ErrSnapshotFormat = errors.New("dataeng: invalid snapshot format")
	// ErrSnapshotConfigMismatch marks a snapshot restored into an operator with
	// a different window specification or allowed lateness.
	ErrSnapshotConfigMismatch = errors.New("dataeng: snapshot configuration mismatch")
)

func wrapError(base error, format string, args ...any) error {
	return fmt.Errorf("%w: %s", base, fmt.Sprintf(format, args...))
}
