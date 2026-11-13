package dataeng

import (
	"errors"
	"fmt"
)

// Key is the auto-increment key type used by the scanner. Auto-increment keys
// are non-negative in the databases this package targets.
type Key = int64

// DefaultStartKey is the first key considered by BeginSnapshot. Zero keeps
// empty sequences and sequences that start at 0 usable; a sequence that starts
// at 1 merely scans one empty key slot first. Use WithStartKey when the lower
// bound is known.
const DefaultStartKey Key = 0

// ChangeLogPosition is an opaque, ordered position in a change log (for
// example a binlog file and offset, an LSN, or a WAL position). The zero value
// means that no change log is attached.
type ChangeLogPosition string

// Valid reports whether the position is non-empty.
func (p ChangeLogPosition) Valid() bool { return p != "" }

var (
	// ErrInvalidCeiling means the snapshot ceiling is negative.
	ErrInvalidCeiling = errors.New("dataeng: snapshot ceiling must be non-negative")
	// ErrInvalidStart means the first key is greater than the ceiling.
	ErrInvalidStart = errors.New("dataeng: start key must not exceed the snapshot ceiling")
	// ErrInvalidLimit means a chunk was requested with a non-positive limit.
	ErrInvalidLimit = errors.New("dataeng: chunk limit must be positive")
	// ErrCursorBeforeStart means the supplied cursor has already moved behind
	// the generation's lower bound.
	ErrCursorBeforeStart = errors.New("dataeng: cursor is before the snapshot lower bound")
	// ErrCursorAfterCeiling means a resumed cursor is beyond the generation
	// ceiling.
	ErrCursorAfterCeiling = errors.New("dataeng: cursor is after the snapshot ceiling")
	// ErrMaxRegressed means MAX(id) moved backwards. It can be caused by
	// deleting the current highest rows or by allocator wraparound/reuse.
	// Without a change log, the two cases cannot be distinguished.
	ErrMaxRegressed = errors.New("dataeng: MAX(id) regressed; a change log is required to distinguish deletes from wraparound")
	// ErrNoPendingChunk means CommitThrough was called before Next returned a
	// chunk.
	ErrNoPendingChunk = errors.New("dataeng: no chunk is pending")
	// ErrChunkPending means Next was called again before the outstanding
	// chunk was committed.
	ErrChunkPending = errors.New("dataeng: previous chunk has not been committed")
	// ErrCommitOutOfRange means a reported last key was outside the pending
	// chunk interval.
	ErrCommitOutOfRange = errors.New("dataeng: committed key is outside the pending chunk")
)

// Cursor is an exclusive keyset cursor. Set is false before the first chunk of
// a snapshot generation.
type Cursor struct {
	Key Key
	Set bool
}

// After returns an exclusive cursor positioned at k.
func After(k Key) Cursor { return Cursor{Key: k, Set: true} }

// Snapshot is an immutable view of one collection generation. The ceiling is
// the maximum auto-increment key captured when the generation began.
//
// The zero value is not a valid snapshot; use BeginSnapshot.
type Snapshot struct {
	generation uint64
	start      Key
	after      Cursor
	ceiling    Key
	changeLog  ChangeLogPosition
}

type snapshotConfig struct {
	start     Key
	changeLog ChangeLogPosition
}

// Option configures a Snapshot.
type Option func(*snapshotConfig) error

// WithStartKey overrides the first key considered by the initial snapshot.
// Use this for sequences that start at 0 or at another known lower bound.
func WithStartKey(k Key) Option {
	return func(c *snapshotConfig) error {
		c.start = k
		return nil
	}
}

// WithChangeLog attaches the change-log position from which low-key inserts,
// deletes, updates, and allocator wraparound will be reconciled.
func WithChangeLog(pos ChangeLogPosition) Option {
	return func(c *snapshotConfig) error {
		c.changeLog = pos
		return nil
	}
}

// BeginSnapshot fixes the inclusive ceiling for the initial snapshot
// generation. The ceiling is captured once and is never widened by later
// reads: rows with keys greater than the ceiling belong to the next
// generation.
func BeginSnapshot(ceiling Key, opts ...Option) (Snapshot, error) {
	return beginSnapshot(1, ceiling, Cursor{}, opts...)
}

func beginSnapshot(generation uint64, ceiling Key, after Cursor, opts ...Option) (Snapshot, error) {
	if ceiling < 0 {
		return Snapshot{}, ErrInvalidCeiling
	}
	cfg := snapshotConfig{start: DefaultStartKey}
	for _, opt := range opts {
		if opt == nil {
			continue
		}
		if err := opt(&cfg); err != nil {
			return Snapshot{}, err
		}
	}
	if after.Set {
		cfg.start = after.Key
	}
	if cfg.start > ceiling {
		return Snapshot{}, ErrInvalidStart
	}
	return Snapshot{
		generation: generation,
		start:      cfg.start,
		after:      after,
		ceiling:    ceiling,
		changeLog:  cfg.changeLog,
	}, nil
}

// Generation returns the monotonically increasing snapshot generation number.
func (s Snapshot) Generation() uint64 { return s.generation }

// Ceiling returns the inclusive maximum key fixed for this generation.
func (s Snapshot) Ceiling() Key { return s.ceiling }

// Watermark is an alias for Ceiling.
func (s Snapshot) Watermark() Key { return s.ceiling }

// Lower returns the exclusive lower bound of this generation. It is unset for
// the initial snapshot.
func (s Snapshot) Lower() Cursor { return s.after }

// ChangeLog returns the change-log position attached to this generation.
func (s Snapshot) ChangeLog() ChangeLogPosition { return s.changeLog }

// HasChangeLog reports whether this generation is backed by a change log.
func (s Snapshot) HasChangeLog() bool { return s.changeLog.Valid() }

// Authoritative reports whether this generation is backed by a change log.
// A key-range-only generation (Authoritative false) is not proof that low-key
// inserts or allocator wraparound were captured; use it only for append-only,
// monotonically increasing keys.
func (s Snapshot) Authoritative() bool { return s.changeLog.Valid() }

// Contains reports whether k is inside this generation's key interval.
func (s Snapshot) Contains(k Key) bool {
	if k > s.ceiling {
		return false
	}
	if s.after.Set && k <= s.after.Key {
		return false
	}
	if !s.after.Set && k < s.start {
		return false
	}
	return true
}

// Chunk is one complete, bounded key interval. After is exclusive when Set.
// When After is unset, From is the inclusive lower bound. Through is always
// inclusive and is never greater than the snapshot ceiling.
//
// The interval width is at most Limit. Because keys are unique, a SQL query of
// the form
//
//	WHERE id > :after AND id <= :through ORDER BY id LIMIT :limit
//
// can read the entire interval without missing a row. Committing Through after
// a successful read is safe even when the interval contains deleted holes or
// zero rows.
type Chunk struct {
	Generation uint64
	After      Cursor
	From       Key
	Through    Key
	Limit      int
}

// First reports whether this is the first chunk of its generation.
func (c Chunk) First() bool { return !c.After.Set }

// Next returns the cursor to use after this chunk has been read in full.
func (c Chunk) Next() Cursor { return After(c.Through) }

// Next plans the next key interval after the supplied cursor. The bool result
// is false when the generation's ceiling has been reached.
//
// Next is a pure function; it does not persist progress. A scan may read fewer
// rows than Limit because of deleted holes, so callers should advance with
// Chunk.Next/Scanner.CommitThrough after the interval has been scanned.
func (s Snapshot) Next(after Cursor, limit int) (Chunk, bool, error) {
	if limit <= 0 {
		return Chunk{}, false, ErrInvalidLimit
	}
	// A generation with a lower bound (every incremental generation) must
	// never re-read the previous generation's ceiling when the caller passes
	// the zero cursor.
	if !after.Set && s.after.Set {
		after = s.after
	}
	if after.Set {
		if after.Key < s.start || (s.after.Set && after.Key < s.after.Key) {
			return Chunk{}, false, fmt.Errorf("%w: cursor %d, start %d", ErrCursorBeforeStart, after.Key, s.start)
		}
		if after.Key >= s.ceiling {
			return Chunk{}, false, nil
		}
	}

	from := s.start
	if after.Set {
		from = after.Key
	}
	if !after.Set && from > s.ceiling {
		return Chunk{}, false, nil
	}

	through := s.ceiling
	if after.Set {
		// ceiling > after here. The unsigned subtraction is exact and cannot
		// overflow even when the interval crosses zero.
		remaining := uint64(s.ceiling) - uint64(after.Key)
		if uint64(limit) < remaining {
			through = after.Key + Key(limit)
		}
	} else {
		remaining := uint64(s.ceiling) - uint64(from)
		if uint64(limit-1) < remaining {
			through = from + Key(limit) - 1
		}
	}

	return Chunk{
		Generation: s.generation,
		After:      after,
		From:       from,
		Through:    through,
		Limit:      limit,
	}, true, nil
}

// NextGeneration starts a new incremental generation after this one. maxKey is
// a freshly observed MAX(id). Rows above the previous ceiling and at or below
// maxKey are assigned to the new generation; later rows go to the generation
// after that.
//
// A maxKey below the previous ceiling is ambiguous: the highest rows may have
// been deleted, or the allocator may have wrapped/reused keys. In that case a
// non-empty changeLog position is required. When changeLog is supplied the
// ceiling never moves backwards; low-key corrections come from the log.
func (s Snapshot) NextGeneration(maxKey Key, changeLog ChangeLogPosition) (Snapshot, error) {
	if maxKey < 0 {
		return Snapshot{}, ErrInvalidCeiling
	}
	if maxKey < s.ceiling && !changeLog.Valid() {
		return Snapshot{}, ErrMaxRegressed
	}

	through := s.ceiling
	if maxKey > through {
		through = maxKey
	}
	next := Snapshot{
		generation: s.generation + 1,
		start:      s.ceiling,
		after:      After(s.ceiling),
		ceiling:    through,
		changeLog:  changeLog,
	}
	if next.start > next.ceiling {
		next.start = next.ceiling
	}
	return next, nil
}

// Scanner tracks keyset progress for one Snapshot. A Scanner is not safe for
// concurrent use.
type Scanner struct {
	snapshot Snapshot
	cursor   Cursor
	pending  *Chunk
}

// NewScanner starts at the snapshot's lower bound.
func NewScanner(s Snapshot) *Scanner {
	return &Scanner{snapshot: s, cursor: s.after}
}

// NewScannerAt resumes a scan at an exclusive cursor. Pass Cursor{} to start at
// the snapshot's normal lower bound.
func NewScannerAt(s Snapshot, cursor Cursor) (*Scanner, error) {
	if !cursor.Set {
		return NewScanner(s), nil
	}
	if cursor.Key < s.start || (s.after.Set && cursor.Key < s.after.Key) {
		return nil, fmt.Errorf("%w: cursor %d, start %d", ErrCursorBeforeStart, cursor.Key, s.start)
	}
	if cursor.Key > s.ceiling {
		return nil, fmt.Errorf("%w: cursor %d, ceiling %d", ErrCursorAfterCeiling, cursor.Key, s.ceiling)
	}
	return &Scanner{snapshot: s, cursor: cursor}, nil
}

// Snapshot returns the immutable snapshot being scanned.
func (s *Scanner) Snapshot() Snapshot { return s.snapshot }

// Cursor returns the current exclusive cursor.
func (s *Scanner) Cursor() Cursor { return s.cursor }

// Done reports whether the generation ceiling has been reached.
func (s *Scanner) Done() bool {
	if s.pending != nil {
		return false
	}
	if s.cursor.Set {
		return s.cursor.Key >= s.snapshot.ceiling
	}
	return s.snapshot.start > s.snapshot.ceiling
}

// Next returns the next chunk. Only one chunk may be outstanding at a time.
func (s *Scanner) Next(limit int) (Chunk, bool, error) {
	if s.pending != nil {
		return Chunk{}, false, ErrChunkPending
	}
	chunk, more, err := s.snapshot.Next(s.cursor, limit)
	if err != nil || !more {
		return chunk, more, err
	}
	s.pending = &chunk
	return chunk, true, nil
}

// CommitThrough advances to the end of the pending interval. It is the normal
// commit path for complete key-range reads and is safe when the interval had
// zero rows or contained deleted keys.
func (s *Scanner) CommitThrough() error {
	if s.pending == nil {
		return ErrNoPendingChunk
	}
	s.cursor = s.pending.Next()
	s.pending = nil
	return nil
}

// AdvanceTo advances to the highest key actually returned by a partial read.
// last must be inside the pending interval. The remainder of the interval will
// be planned again on the next call to Next.
func (s *Scanner) AdvanceTo(last Key) error {
	if s.pending == nil {
		return ErrNoPendingChunk
	}
	below := last < s.pending.From
	if s.pending.After.Set {
		below = last <= s.pending.After.Key
	}
	if below || last > s.pending.Through {
		return fmt.Errorf("%w: key %d, interval [%d,%d]", ErrCommitOutOfRange, last, s.pending.From, s.pending.Through)
	}
	s.cursor = After(last)
	s.pending = nil
	return nil
}
