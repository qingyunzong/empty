package q204

import (
	"errors"
	"fmt"
)

var (
	// ErrInvalidConfig reports a rule set that cannot be used.
	ErrInvalidConfig = errors.New("q204: invalid configuration")
	// ErrAmbiguousMatch reports that two equally specific rules with different
	// actions selected the same value while processing an event. Configuration
	// validation normally catches this before a batch starts; array layouts can
	// make an otherwise distinct pair of paths select the same value.
	ErrAmbiguousMatch = errors.New("q204: ambiguous rule match")
	// ErrNonStringHMAC reports that an HMAC rule matched a non-string value.
	// It always rejects the whole batch.
	ErrNonStringHMAC = errors.New("q204: non-string value matched an HMAC rule")
	// ErrBatchRevoked reports an operation attempted after revoking a batch.
	ErrBatchRevoked = errors.New("q204: batch revoked")
	// ErrKeyStoreRequired reports that an HMAC rule was submitted without a
	// keystore.
	ErrKeyStoreRequired = errors.New("q204: HMAC rule requires a key store")
	// ErrUnsupportedValue reports a value that is not a JSON-like structured
	// value (maps with string keys, arrays, strings, numbers, booleans, or nil).
	ErrUnsupportedValue = errors.New("q204: unsupported structured value")
)

// ConfigError reports an invalid or ambiguous rule set. It contains rule
// locations only; event values are never included.
type ConfigError struct {
	Reason string
	RuleA  string
	RuleB  string
}

func (e *ConfigError) Error() string {
	if e.RuleB != "" {
		return fmt.Sprintf("%v: %s (%s and %s)", ErrInvalidConfig, e.Reason, e.RuleA, e.RuleB)
	}
	return fmt.Sprintf("%v: %s (%s)", ErrInvalidConfig, e.Reason, e.RuleA)
}

func (e *ConfigError) Unwrap() error { return ErrInvalidConfig }

// ValueTypeError reports where a non-string value selected by an HMAC rule
// was encountered. It contains a field path, never the offending value.
type ValueTypeError struct {
	Path string
}

func (e *ValueTypeError) Error() string {
	if e.Path == "" {
		return ErrNonStringHMAC.Error()
	}
	return fmt.Sprintf("%v at %s", ErrNonStringHMAC, e.Path)
}

func (e *ValueTypeError) Unwrap() error { return ErrNonStringHMAC }

// AmbiguousMatchError reports the location at which two equally specific
// rules selected one value with different actions. It never includes event
// values.
type AmbiguousMatchError struct {
	Path string
}

func (e *AmbiguousMatchError) Error() string {
	if e.Path == "" {
		return ErrAmbiguousMatch.Error()
	}
	return fmt.Sprintf("%v at %s", ErrAmbiguousMatch, e.Path)
}

func (e *AmbiguousMatchError) Unwrap() error { return ErrAmbiguousMatch }
