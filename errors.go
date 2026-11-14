package dataeng

import "fmt"

// Error describes a failure while parsing or converting a unit expression.
// Pos and End are byte offsets into the offending input; Pos is -1 when the
// failure is not tied to a location (for example a dimension mismatch).
type Error struct {
	Pos int
	End int
	Msg string
}

func (e *Error) Error() string {
	if e.Pos < 0 {
		return "unit: " + e.Msg
	}
	return fmt.Sprintf("unit: position %d: %s", e.Pos, e.Msg)
}

func errAt(pos, end int, format string, args ...any) *Error {
	return &Error{Pos: pos, End: end, Msg: fmt.Sprintf(format, args...)}
}

func errPlain(format string, args ...any) *Error {
	return &Error{Pos: -1, End: -1, Msg: fmt.Sprintf(format, args...)}
}
