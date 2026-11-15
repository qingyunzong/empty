package dataeng

import "errors"

// ErrInvalidInput marks malformed records, targets, or configuration.
var ErrInvalidInput = errors.New("dataeng: invalid input")
