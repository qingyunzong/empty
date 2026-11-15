package dataeng

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// MemorySnapshot is an in-memory KeySource useful for tests and for planning
// against an already-materialized key set. It never changes after creation.
type MemorySnapshot struct {
	cols   []KeyColumn
	rows   []Tuple
	closed bool
	mu     sync.Mutex
}

// NewMemorySnapshot builds an immutable snapshot. When cols is empty the table
// is treated as having no primary key. Rows are sorted into key order.
func NewMemorySnapshot(cols []KeyColumn, rows []Tuple) (*MemorySnapshot, error) {
	if len(cols) > 0 {
		if err := ValidateColumns(cols); err != nil {
			return nil, err
		}
	}
	copied := make([]Tuple, len(rows))
	for i, row := range rows {
		if len(cols) > 0 && len(row) != len(cols) {
			return nil, fmt.Errorf("%w: row %d has %d values, want %d",
				ErrInvalidKey, i, len(row), len(cols))
		}
		copied[i] = append(Tuple(nil), row...)
	}
	if len(cols) > 0 {
		if err := SortTuples(copied, cols); err != nil {
			return nil, err
		}
	}
	return &MemorySnapshot{
		cols: append([]KeyColumn(nil), cols...),
		rows: copied,
	}, nil
}

func (s *MemorySnapshot) PrimaryKey(context.Context, string) ([]KeyColumn, error) {
	if err := s.open(); err != nil {
		return nil, err
	}
	if len(s.cols) == 0 {
		return nil, ErrNoPrimaryKey
	}
	return append([]KeyColumn(nil), s.cols...), nil
}

func (s *MemorySnapshot) CountRows(context.Context, string) (int64, error) {
	if err := s.open(); err != nil {
		return 0, err
	}
	return int64(len(s.rows)), nil
}

// SampleKeys returns keys at evenly spaced row positions. The first row is
// never returned, so the first chunk contains at least one row when data exists.
func (s *MemorySnapshot) SampleKeys(_ context.Context, _ string, cols []KeyColumn, limit int) ([]Tuple, error) {
	if err := s.open(); err != nil {
		return nil, err
	}
	if limit <= 0 || len(s.rows) == 0 {
		return nil, nil
	}
	if err := sameColumns(cols, s.cols); err != nil {
		return nil, err
	}

	n := int64(len(s.rows))
	stride := (n + int64(limit)) / int64(limit+1)
	if stride < 1 {
		stride = 1
	}
	out := make([]Tuple, 0, limit)
	for pos := stride; pos < n && len(out) < limit; pos += stride {
		out = append(out, append(Tuple(nil), s.rows[pos]...))
	}
	return out, nil
}

func (s *MemorySnapshot) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	return nil
}

func (s *MemorySnapshot) open() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrSnapshotClosed
	}
	return nil
}

// MemorySource opens independent MemorySnapshots over the same rows.
type MemorySource struct {
	cols []KeyColumn
	rows []Tuple

	mu      sync.Mutex
	begins  int
	closes  int
	lastSnp *MemorySnapshot
}

// NewMemorySource constructs a Source.
func NewMemorySource(cols []KeyColumn, rows []Tuple) (*MemorySource, error) {
	snap, err := NewMemorySnapshot(cols, rows)
	if err != nil {
		return nil, err
	}
	return &MemorySource{cols: snap.cols, rows: snap.rows}, nil
}

func (s *MemorySource) BeginSnapshot(context.Context) (Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.begins++
	snap, err := NewMemorySnapshot(s.cols, s.rows)
	if err != nil {
		return nil, err
	}
	s.lastSnp = snap
	return &countedSnapshot{MemorySnapshot: snap, source: s}, nil
}

type countedSnapshot struct {
	*MemorySnapshot
	source *MemorySource
	once   sync.Once
}

func (s *countedSnapshot) Close() error {
	err := s.MemorySnapshot.Close()
	s.once.Do(func() {
		s.source.mu.Lock()
		s.source.closes++
		s.source.mu.Unlock()
	})
	return err
}

func sameColumns(a, b []KeyColumn) error {
	if len(a) != len(b) {
		return fmt.Errorf("%w: got %d columns, snapshot has %d",
			ErrInvalidKey, len(a), len(b))
	}
	for i := range a {
		if a[i].Name != b[i].Name {
			return fmt.Errorf("%w: column %d is %q, snapshot has %q",
				ErrInvalidKey, i, a[i].Name, b[i].Name)
		}
	}
	return nil
}

var (
	// ErrSnapshotClosed is returned when a closed snapshot is queried.
	ErrSnapshotClosed = errors.New("dataeng: snapshot is closed")
)
