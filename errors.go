package dataeng

import "errors"

var (
	// ErrInvalidInterval indicates that an interval's start is greater than
	// its end.
	ErrInvalidInterval = errors.New("dataeng: interval start is greater than end")

	// ErrDuplicateStart indicates that two intervals have the same start.
	ErrDuplicateStart = errors.New("dataeng: duplicate interval start")

	// ErrUnknownWorker indicates that a report refers to an interval that was
	// not assigned.
	ErrUnknownWorker = errors.New("dataeng: unknown worker")

	// ErrKeyOutsideInterval indicates that a report contains a key outside the
	// worker's inclusive interval.
	ErrKeyOutsideInterval = errors.New("dataeng: reported key is outside the worker interval")

	// ErrOverlappingKey indicates that a report contains a key in an overlap
	// owned by an interval with a smaller start.
	ErrOverlappingKey = errors.New("dataeng: reported key is owned by an interval with a smaller start")

	// ErrExhaustedAtEnd indicates that a report is both marked exhausted and
	// ends at the interval's end.
	ErrExhaustedAtEnd = errors.New("dataeng: exhausted report ends at the interval end")

	// ErrIntervalFinal indicates that a report was submitted for an interval
	// that is already complete or failed.
	ErrIntervalFinal = errors.New("dataeng: interval is already final")
)

// ErrKeyOutOfRange is an alias for ErrKeyOutsideInterval.
var ErrKeyOutOfRange = ErrKeyOutsideInterval
