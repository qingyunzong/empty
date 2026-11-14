package dataeng

import "errors"

var (
	// ErrStateNotFound is returned by a StateStore when no checkpoint exists.
	ErrStateNotFound = errors.New("dataeng: state not found")
	// ErrInvalidSnapshot indicates an incomplete or inconsistent snapshot binding.
	ErrInvalidSnapshot = errors.New("dataeng: invalid snapshot")
	// ErrSnapshotMismatch means persisted state belongs to a different exported
	// snapshot, consistent point, slot, database, or relation schema binding.
	ErrSnapshotMismatch = errors.New("dataeng: snapshot binding does not match persisted state")
	// ErrInvalidRelation indicates a malformed relation schema version.
	ErrInvalidRelation = errors.New("dataeng: invalid relation")
	// ErrRelationNotFound indicates a change references an unknown relation or
	// schema version.
	ErrRelationNotFound = errors.New("dataeng: relation version not found")
	// ErrRelationVersionConflict indicates two different schemas claim the same
	// relation ID and version, or version ordering is not monotonic.
	ErrRelationVersionConflict = errors.New("dataeng: relation version conflict")
	// ErrFutureRelationVersion means a tuple references a schema version whose
	// DDL has not happened yet at the tuple's WAL position.
	ErrFutureRelationVersion = errors.New("dataeng: relation version is newer than change LSN")
	// ErrInvalidRow indicates a tuple does not match its declared schema version.
	ErrInvalidRow = errors.New("dataeng: invalid row")
	// ErrInvalidChange indicates a malformed WAL change.
	ErrInvalidChange = errors.New("dataeng: invalid change")
	// ErrSnapshotRowConflict means the same snapshot primary key appeared twice
	// with different tuple contents.
	ErrSnapshotRowConflict = errors.New("dataeng: conflicting duplicate snapshot row")
	// ErrNonMonotonicLSN means the WAL source emitted changes out of order.
	ErrNonMonotonicLSN = errors.New("dataeng: non-monotonic WAL change LSN")
	// ErrFlushRegression means a new durable position would move backwards.
	ErrFlushRegression = errors.New("dataeng: flush LSN regression")
	// ErrInvalidState indicates a corrupt or logically inconsistent checkpoint.
	ErrInvalidState = errors.New("dataeng: invalid state")
	// ErrInvalidConfig indicates missing or inconsistent coordinator options.
	ErrInvalidConfig = errors.New("dataeng: invalid config")
	// ErrStateChecksum indicates the persisted checkpoint failed validation.
	ErrStateChecksum = errors.New("dataeng: state checksum mismatch")
)
