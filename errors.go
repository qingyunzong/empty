package dataeng

import "errors"

// Sentinel errors returned by the compaction state component. Callers can use
// errors.Is to detect a specific failure class regardless of the wrapped
// contextual message.
var (
	// ErrNothingToCompact is returned when a partition does not contain enough
	// unoccupied, active files to satisfy the planning threshold.
	ErrNothingToCompact = errors.New("dataeng: no eligible files to compact")

	// ErrPlanNotFound is returned when a plan id is unknown to the manager.
	ErrPlanNotFound = errors.New("dataeng: compaction plan not found")

	// ErrPlanNotOpen is returned when a plan is already committed, failed or
	// aborted and a terminal operation is attempted on it.
	ErrPlanNotOpen = errors.New("dataeng: compaction plan is not open")

	// ErrPlanIDExists is returned when an explicitly requested plan id is
	// already in use.
	ErrPlanIDExists = errors.New("dataeng: compaction plan id already exists")

	// ErrConflict is returned at commit time when one or more input files of
	// the plan are no longer active, typically because another intersecting
	// compaction committed first. No state is mutated on conflict.
	ErrConflict = errors.New("dataeng: conflicting compaction: input files no longer active")

	// ErrEmptyOutput is returned when a commit carries no output files.
	ErrEmptyOutput = errors.New("dataeng: compaction must produce at least one output file")

	// ErrInvalidPath is returned when a file has an empty path.
	ErrInvalidPath = errors.New("dataeng: file path must not be empty")

	// ErrDuplicatePath is returned when the same path appears more than once
	// in a single operation.
	ErrDuplicatePath = errors.New("dataeng: duplicate file path")

	// ErrOutputExists is returned when a commit wants to add an output path
	// that is already known to the table.
	ErrOutputExists = errors.New("dataeng: output file already exists in the table")

	// ErrPartitionMismatch is returned when an output does not belong to the
	// partition compacted by the plan.
	ErrPartitionMismatch = errors.New("dataeng: output file does not belong to the plan partition")
)
