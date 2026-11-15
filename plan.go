package dataeng

import (
	"context"
	"errors"
	"fmt"
	"math"
)

// DefaultChunkCount is used when neither ChunkCount nor RowsPerChunk is set.
const DefaultChunkCount = 8

// KeySource is the part of a database snapshot needed to plan chunk
// boundaries. Implementations must execute every method inside one
// repeatable snapshot. In particular, SampleKeys must not open a new
// transaction or read inconsistent data between calls.
type KeySource interface {
	// PrimaryKey returns the columns of the table's primary key in index order.
	// It returns ErrNoPrimaryKey when the table has no primary key.
	PrimaryKey(ctx context.Context, table string) ([]KeyColumn, error)

	// CountRows returns the number of rows visible in the snapshot. It may
	// return -1 when the count is not known; a caller that requests
	// RowsPerChunk then receives ErrUnknownRowCount.
	CountRows(ctx context.Context, table string) (int64, error)

	// SampleKeys returns up to limit distinct primary-key tuples distributed
	// across the snapshot and ordered by cols. Returning fewer is valid.
	SampleKeys(ctx context.Context, table string, cols []KeyColumn, limit int) ([]Tuple, error)
}

// Snapshot is a stable, transaction-scoped view of a database. BuildPlan only
// needs KeySource. Plans created by Planner retain the Snapshot and close it
// after extraction.
type Snapshot interface {
	KeySource
	Close() error
}

// Source opens snapshots. A Planner calls BeginSnapshot exactly once per plan,
// so boundary sampling and subsequent chunk extraction can use the same
// transaction.
type Source interface {
	BeginSnapshot(ctx context.Context) (Snapshot, error)
}

// Options controls how many chunks BuildPlan produces.
//
// If RowsPerChunk is positive it takes precedence over ChunkCount. ChunkCount
// is otherwise used, defaulting to DefaultChunkCount. MaxChunks, when positive,
// caps the result. SampleLimit caps the number of sampled boundary keys.
type Options struct {
	RowsPerChunk int64
	ChunkCount   int
	MaxChunks    int
	SampleLimit  int
}

func (o Options) validate() error {
	if o.RowsPerChunk < 0 {
		return fmt.Errorf("%w: negative RowsPerChunk", ErrInvalidPlan)
	}
	if o.ChunkCount < 0 {
		return fmt.Errorf("%w: negative ChunkCount", ErrInvalidPlan)
	}
	if o.MaxChunks < 0 {
		return fmt.Errorf("%w: negative MaxChunks", ErrInvalidPlan)
	}
	if o.SampleLimit < 0 {
		return fmt.Errorf("%w: negative SampleLimit", ErrInvalidPlan)
	}
	return nil
}

// Plan is a non-overlapping partition of a table's complete primary-key
// space. Chunks are [lower, upper) and always cover (-inf, +inf).
type Plan struct {
	Table      string
	KeyColumns []KeyColumn
	Chunks     []Chunk
	Boundaries []Tuple
	TotalRows  int64

	// Snapshot is the source used for sampling when it exposes a Snapshot.
	// Only Planner-created plans own it; Plan.Close closes owned snapshots.
	Snapshot Snapshot

	owned  bool
	closed bool
}

// Validate re-checks the no-gap/no-overlap invariant.
func (p *Plan) Validate() error {
	if p == nil {
		return fmt.Errorf("%w: nil plan", ErrInvalidPlan)
	}
	if p.Table == "" {
		return fmt.Errorf("%w: plan has an empty table", ErrInvalidPlan)
	}
	if err := ValidateColumns(p.KeyColumns); err != nil {
		return err
	}
	return ValidateChunks(p.Chunks, p.KeyColumns)
}

// Close closes the snapshot owned by a Planner-created plan. It is safe to
// call more than once. Plans returned by BuildPlan do not own the snapshot,
// so Close is a no-op for them.
func (p *Plan) Close() error {
	if p == nil || !p.owned || p.closed || p.Snapshot == nil {
		return nil
	}
	p.closed = true
	return p.Snapshot.Close()
}

// BuildPlan plans chunks using the caller-provided snapshot. The caller keeps
// ownership of the snapshot and is responsible for closing it. BuildPlan
// never falls back to LIMIT/OFFSET pagination.
func BuildPlan(ctx context.Context, src KeySource, table string, opts Options) (*Plan, error) {
	if src == nil {
		return nil, fmt.Errorf("%w: nil key source", ErrInvalidPlan)
	}
	if table == "" {
		return nil, fmt.Errorf("%w: empty table name", ErrInvalidPlan)
	}
	if err := opts.validate(); err != nil {
		return nil, err
	}

	cols, err := src.PrimaryKey(ctx, table)
	if err != nil {
		if errors.Is(err, ErrNoPrimaryKey) {
			return nil, &NoPrimaryKeyError{Table: table}
		}
		return nil, fmt.Errorf("inspect primary key of %q: %w", table, err)
	}
	if len(cols) == 0 {
		return nil, &NoPrimaryKeyError{Table: table}
	}
	if err := ValidateColumns(cols); err != nil {
		return nil, fmt.Errorf("primary key of %q: %w", table, err)
	}

	total, err := src.CountRows(ctx, table)
	if err != nil {
		return nil, fmt.Errorf("count rows in %q: %w", table, err)
	}
	if total < -1 {
		return nil, fmt.Errorf("%w: invalid row count %d", ErrInvalidPlan, total)
	}

	boundaryLimit, err := boundaryCount(total, opts)
	if err != nil {
		return nil, err
	}

	var boundaries []Tuple
	if boundaryLimit > 0 {
		sampled, err := src.SampleKeys(ctx, table, cols, boundaryLimit)
		if err != nil {
			return nil, fmt.Errorf("sample key boundaries in %q: %w", table, err)
		}
		boundaries, err = normalizeBoundaries(sampled, cols, boundaryLimit)
		if err != nil {
			return nil, fmt.Errorf("sample key boundaries in %q: %w", table, err)
		}
	}

	chunks := makeChunks(table, boundaries)
	plan := &Plan{
		Table:      table,
		KeyColumns: append([]KeyColumn(nil), cols...),
		Chunks:     chunks,
		Boundaries: append([]Tuple(nil), boundaries...),
		TotalRows:  total,
	}
	if snap, ok := src.(Snapshot); ok {
		plan.Snapshot = snap
	}
	if err := plan.Validate(); err != nil {
		return nil, err
	}
	return plan, nil
}

// Planner opens one snapshot and plans a table inside it. The returned plan
// owns the snapshot; close it after all chunk reads finish.
type Planner struct {
	Source  Source
	Options Options
}

// Plan is a convenience wrapper around BuildPlan that manages the snapshot
// lifetime.
func (p *Planner) Plan(ctx context.Context, table string) (*Plan, error) {
	if p == nil || p.Source == nil {
		return nil, fmt.Errorf("%w: nil snapshot source", ErrInvalidPlan)
	}
	snap, err := p.Source.BeginSnapshot(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin snapshot: %w", err)
	}
	if snap == nil {
		return nil, fmt.Errorf("%w: snapshot source returned nil", ErrInvalidPlan)
	}
	plan, err := BuildPlan(ctx, snap, table, p.Options)
	if err != nil {
		return nil, errors.Join(err, snap.Close())
	}
	plan.Snapshot = snap
	plan.owned = true
	return plan, nil
}

func boundaryCount(total int64, opts Options) (int, error) {
	desired := opts.ChunkCount
	if opts.RowsPerChunk > 0 {
		if total < 0 {
			return 0, fmt.Errorf("%w: row count is required for RowsPerChunk",
				ErrUnknownRowCount)
		}
		if total == 0 {
			return 0, nil
		}
		quotient := total / opts.RowsPerChunk
		if total%opts.RowsPerChunk != 0 {
			quotient++
		}
		if quotient > int64(math.MaxInt-1) {
			quotient = int64(math.MaxInt - 1)
		}
		desired = int(quotient)
		if desired < 1 {
			desired = 1
		}
	} else if desired == 0 {
		desired = DefaultChunkCount
	}
	if desired < 1 {
		desired = 1
	}
	if opts.MaxChunks > 0 && desired > opts.MaxChunks {
		desired = opts.MaxChunks
	}
	if desired > math.MaxInt-1 {
		desired = math.MaxInt - 1
	}

	limit := desired - 1
	if total >= 0 {
		maxByRows := total - 1
		if maxByRows < 0 {
			maxByRows = 0
		}
		if int64(limit) > maxByRows {
			limit = int(maxByRows)
		}
	}
	if opts.SampleLimit > 0 && limit > opts.SampleLimit {
		limit = opts.SampleLimit
	}
	return limit, nil
}

func normalizeBoundaries(sampled []Tuple, cols []KeyColumn, limit int) ([]Tuple, error) {
	if len(sampled) == 0 || limit == 0 {
		return nil, nil
	}
	for i, key := range sampled {
		if len(key) != len(cols) {
			return nil, fmt.Errorf("%w: sampled key %d has %d values, want %d",
				ErrInvalidKey, i, len(key), len(cols))
		}
	}

	out := make([]Tuple, 0, len(sampled))
	for _, key := range sampled {
		out = append(out, append(Tuple(nil), key...))
	}
	if err := SortTuples(out, cols); err != nil {
		return nil, err
	}

	unique := out[:0]
	for _, key := range out {
		if len(unique) == 0 {
			unique = append(unique, key)
			continue
		}
		cmp, err := CompareTuples(unique[len(unique)-1], key, cols)
		if err != nil {
			return nil, err
		}
		if cmp != 0 {
			unique = append(unique, key)
		}
	}
	out = unique

	if len(out) > limit {
		out = selectEvenly(out, limit)
	}
	return out, nil
}

func selectEvenly(keys []Tuple, limit int) []Tuple {
	if limit >= len(keys) {
		return keys
	}
	selected := make([]Tuple, 0, limit)
	for i := 1; i <= limit; i++ {
		idx := int(int64(i) * int64(len(keys)) / int64(limit+1))
		if idx >= len(keys) {
			idx = len(keys) - 1
		}
		selected = append(selected, keys[idx])
	}
	return selected
}

func makeChunks(table string, boundaries []Tuple) []Chunk {
	chunks := make([]Chunk, 0, len(boundaries)+1)
	lower := Unbounded()
	for i, boundary := range boundaries {
		chunks = append(chunks, Chunk{
			Table: table,
			Index: i,
			Lower: lower,
			Upper: ExclusiveKey(boundary),
		})
		lower = InclusiveKey(boundary)
	}
	chunks = append(chunks, Chunk{
		Table: table,
		Index: len(boundaries),
		Lower: lower,
		Upper: Unbounded(),
	})
	return chunks
}

// NoPrimaryKeyError is returned for tables that cannot be range-partitioned
// safely. The planner deliberately has no offset-pagination fallback.
type NoPrimaryKeyError struct {
	Table string
}

func (e *NoPrimaryKeyError) Error() string {
	return fmt.Sprintf("table %q has no primary key; "+
		"full extraction requires a stable key order", e.Table)
}

func (e *NoPrimaryKeyError) Unwrap() error { return ErrNoPrimaryKey }

var (
	// ErrNoPrimaryKey is returned for tables without a primary key.
	ErrNoPrimaryKey = errors.New("dataeng: table has no primary key")
	// ErrUnknownRowCount is returned when RowsPerChunk needs a row count
	// that the source did not provide.
	ErrUnknownRowCount = errors.New("dataeng: row count unavailable")
)
