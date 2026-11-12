package dataeng

import "fmt"

// Error describes why a buffer was rejected or why a path read failed.
type Error struct {
	// Phase is "open" for validation failures and "read" for access failures.
	Phase string
	// Path is the field path at which the failure was detected. It may be
	// empty for buffer-level failures.
	Path string
	// Reason is the human-readable cause.
	Reason string
}

func (e *Error) Error() string {
	if e.Path == "" {
		return fmt.Sprintf("dataeng: %s: %s", e.Phase, e.Reason)
	}
	return fmt.Sprintf("dataeng: %s at %s: %s", e.Phase, e.Path, e.Reason)
}

func openError(path, format string, args ...any) error {
	return &Error{Phase: "open", Path: path, Reason: fmt.Sprintf(format, args...)}
}

func readError(path, format string, args ...any) error {
	return &Error{Phase: "read", Path: path, Reason: fmt.Sprintf(format, args...)}
}
