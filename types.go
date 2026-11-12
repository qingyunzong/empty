package dataeng

import (
	"context"
	"errors"
)

// ErrComplete is returned by Merger.Next after every source has been
// consumed and the completion checkpoint has been durably confirmed.
var ErrComplete = errors.New("dataeng: merge complete")

// ErrRejected is returned by a Transaction.Confirm implementation when the
// transaction failed explicitly. A failure wrapped with ErrRejected must mean
// that neither the delivered records nor the checkpoint were committed.
var ErrRejected = errors.New("dataeng: confirmation rejected")

// ErrAmbiguous is a generic non-rejected confirmation error indicating that
// the transaction outcome is unknown. The Merger responds by reloading the
// durable checkpoint before doing anything else.
var ErrAmbiguous = errors.New("dataeng: confirmation outcome unknown")

// Record is an immutable snapshot record. Records are ordered by Time then ID.
type Record struct {
	// ID identifies a record. The same ID carries identical Time and Content
	// across every source.
	ID string
	// Time is the integer ordering key, compared before ID.
	Time int64
	// Content is the opaque record payload.
	Content []byte
}

// SortKey is the global ordering key of a delivered record.
type SortKey struct {
	Time int64
	ID   string
}

// Key returns the ordering key of the record.
func (r Record) Key() SortKey {
	return SortKey{Time: r.Time, ID: r.ID}
}

// Compare reports whether k sorts before, equal to, or after other:
// -1 when k < other, 0 when equal, +1 when k > other.
func (k SortKey) Compare(other SortKey) int {
	switch {
	case k.Time < other.Time:
		return -1
	case k.Time > other.Time:
		return 1
	case k.ID < other.ID:
		return -1
	case k.ID > other.ID:
		return 1
	default:
		return 0
	}
}

// Source is one immutable, cursor-paginated snapshot. Implementations must be
// safe for the Merger to call sequentially; concurrent use is not required.
type Source interface {
	// Name uniquely identifies the source within a Merger.
	Name() string
	// Fetch returns the records of the page identified by cursor and the
	// cursor of the next page. Pages are never empty. An empty nextCursor
	// marks the returned page as the final one. Non-final cursors are unique
	// inside the snapshot.
	Fetch(ctx context.Context, cursor string) (records []Record, nextCursor string, err error)
}

// SourceCheckpoint records how far a single source has been consumed.
type SourceCheckpoint struct {
	// Cursor is the cursor of the page currently being consumed, i.e. the
	// page that contains the next unconsumed record. It is empty only after
	// the source has been fully exhausted.
	Cursor string
	// NextCursor is the cursor of the page following Cursor, or empty when
	// the current page is the final page or the source is exhausted.
	NextCursor string
	// Consumed is the number of records already consumed inside the current
	// page. It is zero for an exhausted source.
	Consumed int
}

// Checkpoint is the durable, resumable state of a merge.
type Checkpoint struct {
	// Sources maps each source name to its per-source checkpoint.
	Sources map[string]SourceCheckpoint
	// LastDelivered is the ordering key of the most recently delivered
	// record. It is nil before the first successful batch.
	LastDelivered *SortKey
	// Complete is set once all sources are exhausted and the final state has
	// been durably confirmed.
	Complete bool
}

// Clone returns a deep copy of the checkpoint so callers cannot mutate
// internal Merger state through an obtained pointer.
func (c *Checkpoint) Clone() *Checkpoint {
	if c == nil {
		return nil
	}
	clone := &Checkpoint{Complete: c.Complete}
	if c.Sources != nil {
		clone.Sources = make(map[string]SourceCheckpoint, len(c.Sources))
		for name, state := range c.Sources {
			clone.Sources[name] = state
		}
	}
	if c.LastDelivered != nil {
		key := *c.LastDelivered
		clone.LastDelivered = &key
	}
	return clone
}

// CheckpointStore persists checkpoints and reloads them during recovery.
type CheckpointStore interface {
	// Load returns the most recently saved checkpoint. A nil checkpoint with
	// a nil error means no checkpoint has been saved yet.
	Load(ctx context.Context) (*Checkpoint, error)
	// Save persists a checkpoint. Implementations used together with a
	// Transaction normally only need durability once Confirm commits.
	Save(ctx context.Context, checkpoint *Checkpoint) error
}

// Transaction atomically commits a delivered batch together with its
// checkpoint. The caller implements the concrete transactional sink.
type Transaction interface {
	// Confirm attempts to commit records and checkpoint together.
	//
	// Returning nil means the commit is durable. Wrapping ErrRejected means
	// an explicit, known failure: nothing was committed and the Merger keeps
	// its position without reloading. Any other error means the outcome is
	// unknown; the Merger reloads the durable checkpoint before proceeding.
	Confirm(ctx context.Context, records []Record, checkpoint *Checkpoint) error
}
