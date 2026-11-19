package formal

import (
	"errors"
	"fmt"
)

var (
	// ErrInvalidConfig is returned (possibly wrapped) when a configuration
	// cannot be compiled into a resolver.
	ErrInvalidConfig = errors.New("invalid resolver config")

	// ErrInvalidName is returned (possibly wrapped) when the name supplied to
	// Resolve is not a syntactically valid DNS host name.
	ErrInvalidName = errors.New("invalid query name")

	// ErrNoTransport is returned when a query needs to be forwarded but no
	// Transport was supplied.
	ErrNoTransport = errors.New("no transport configured")
)

// ConfigError describes a single invalid configuration field.
type ConfigError struct {
	Field  string
	Value  any
	Reason string
}

func (e *ConfigError) Error() string {
	if e.Field == "" {
		return fmt.Sprintf("%v: %s", ErrInvalidConfig, e.Reason)
	}
	return fmt.Sprintf("%v: %s: %s (%v)", ErrInvalidConfig, e.Field, e.Reason, e.Value)
}

// Unwrap makes errors.Is(err, ErrInvalidConfig) true.
func (e *ConfigError) Unwrap() error { return ErrInvalidConfig }

func configError(field string, value any, format string, args ...any) error {
	return &ConfigError{Field: field, Value: value, Reason: fmt.Sprintf(format, args...)}
}
