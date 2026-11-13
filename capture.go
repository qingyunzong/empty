package dataeng

import (
	"context"
	"errors"
)

// ErrNilSource means CaptureSnapshot was called without a key source.
var ErrNilSource = errors.New("dataeng: nil max-key source")

// MaxKeySource supplies the current maximum auto-increment key. Implementations
// should read MAX(id) from the same consistent view or transaction that the
// collector will use for the snapshot. Reading it independently can expose a
// ceiling that does not match the rows later scanned.
type MaxKeySource interface {
	MaxAutoIncrementKey(ctx context.Context) (Key, error)
}

// CaptureSnapshot reads MAX(id) exactly once and freezes it as the snapshot
// ceiling. Rows inserted after this call receive keys above the ceiling and are
// handled by a later generation.
func CaptureSnapshot(ctx context.Context, src MaxKeySource, opts ...Option) (Snapshot, error) {
	if src == nil {
		return Snapshot{}, ErrNilSource
	}
	ceiling, err := src.MaxAutoIncrementKey(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	return BeginSnapshot(ceiling, opts...)
}
