package dataeng

import (
	"errors"
	"fmt"
)

var (
	// ErrInvalidSchema reports a malformed table schema.
	ErrInvalidSchema = errors.New("dataeng: invalid schema")
	// ErrInvalidRow reports a row that does not conform to the schema.
	ErrInvalidRow = errors.New("dataeng: invalid row")
	// ErrInvalidBatch reports a malformed or invalid operation in a batch.
	ErrInvalidBatch = errors.New("dataeng: invalid batch")
	// ErrMissingRow reports an update or delete whose old row is absent. It is
	// also an invalid batch.
	ErrMissingRow = fmt.Errorf("%w: missing row", ErrInvalidBatch)
	// ErrBadBefore reports a before-image that disagrees with the old row. It
	// is also an invalid batch.
	ErrBadBefore = fmt.Errorf("%w: before image mismatch", ErrInvalidBatch)
	// ErrConflict reports a final table with duplicate primary keys or another
	// batch-level conflict. It is also an invalid batch.
	ErrConflict = fmt.Errorf("%w: conflict", ErrInvalidBatch)
)
