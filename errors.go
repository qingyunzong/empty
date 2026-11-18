package formal

import "errors"

var (
	// ErrInvalidCapacity indicates that a cluster capacity vector is empty or
	// contains negative/unnamed resources.
	ErrInvalidCapacity = errors.New("drf: invalid capacity")
	// ErrInvalidQueue indicates an invalid queue definition.
	ErrInvalidQueue = errors.New("drf: invalid queue")
	// ErrInvalidTask indicates an invalid task demand or metadata.
	ErrInvalidTask = errors.New("drf: invalid task")
	// ErrQueueExists indicates a duplicate queue identifier.
	ErrQueueExists = errors.New("drf: queue already exists")
	// ErrUnknownQueue indicates that a task refers to an unregistered queue.
	ErrUnknownQueue = errors.New("drf: unknown queue")
	// ErrTaskExists indicates a duplicate task identifier.
	ErrTaskExists = errors.New("drf: task already exists")
	// ErrUnknownTask indicates that a task identifier is not known.
	ErrUnknownTask = errors.New("drf: unknown task")
	// ErrTaskNotRunning indicates that an operation requires a running task.
	ErrTaskNotRunning = errors.New("drf: task is not running")
	// ErrSchedulingLoop indicates that the scheduler could not reach a fixed
	// point. It should not occur with the built-in policies; it is a safety
	// net against policy bugs.
	ErrSchedulingLoop = errors.New("drf: scheduling did not converge")
)
