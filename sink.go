package dataeng

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
)

// Sink receives snapshot and WAL batches.
//
// ApplySnapshot must durably upsert every row by primary key and return only
// after the data is confirmed. ApplyChanges must durably apply every change and
// return only after confirmation. Both methods must be idempotent: a crash can
// happen after confirmation but before the coordinator persists its checkpoint,
// in which case the same batch is delivered again. Deduplicating snapshot rows
// by primary key and changes by LSN is sufficient.
//
// A sink must not retain the batch slice after returning; copy rows or changes
// that need to outlive the call.
type Sink interface {
	ApplySnapshot(ctx context.Context, rows []SnapshotRow) error
	ApplyChanges(ctx context.Context, changes []Change) error
}

// SinkFuncs adapts functions to Sink.
type SinkFuncs struct {
	Snapshot func(ctx context.Context, rows []SnapshotRow) error
	Changes  func(ctx context.Context, changes []Change) error
}

// ApplySnapshot implements Sink.
func (s SinkFuncs) ApplySnapshot(ctx context.Context, rows []SnapshotRow) error {
	if s.Snapshot == nil {
		return nil
	}
	return s.Snapshot(ctx, rows)
}

// ApplyChanges implements Sink.
func (s SinkFuncs) ApplyChanges(ctx context.Context, changes []Change) error {
	if s.Changes == nil {
		return nil
	}
	return s.Changes(ctx, changes)
}

// MemoryRow is a materialized row in MemorySink.
type MemoryRow struct {
	RelationID uint32
	Row        Row
}

// MemorySink is an idempotent in-memory Sink used by tests and examples. It
// deduplicates snapshot rows by canonical primary key and changes by LSN.
type MemorySink struct {
	mu            sync.Mutex
	rows          map[string]MemoryRow
	snapshotSeen  map[string]struct{}
	changeSeen    map[LSN]struct{}
	changes       []Change
	snapshotCalls int
	changeCalls   int
	durableLSN    LSN
}

// NewMemorySink returns an empty idempotent sink.
func NewMemorySink() *MemorySink {
	return &MemorySink{
		rows:         make(map[string]MemoryRow),
		snapshotSeen: make(map[string]struct{}),
		changeSeen:   make(map[LSN]struct{}),
	}
}

// ApplySnapshot implements Sink.
func (s *MemorySink) ApplySnapshot(ctx context.Context, rows []SnapshotRow) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snapshotCalls++
	for _, row := range rows {
		if row.Schema == nil {
			return fmt.Errorf("%w: snapshot row has no resolved schema", ErrInvalidRow)
		}
		key, err := row.Schema.Key(row.Row)
		if err != nil {
			return err
		}
		if _, exists := s.snapshotSeen[key.String()]; exists {
			continue
		}
		stableKey, err := stableDataKey(*row.Schema, row.Row)
		if err != nil {
			return err
		}
		s.snapshotSeen[key.String()] = struct{}{}
		s.rows[stableKey] = MemoryRow{RelationID: row.Schema.ID, Row: row.Row.Clone()}
	}
	return nil
}

// ApplyChanges implements Sink.
func (s *MemorySink) ApplyChanges(ctx context.Context, changes []Change) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.changeCalls++
	for _, change := range changes {
		if _, exists := s.changeSeen[change.LSN]; exists {
			continue
		}
		if change.Schema == nil {
			return fmt.Errorf("%w: change %s has no resolved schema", ErrInvalidChange, change.LSN)
		}
		switch change.Kind {
		case ChangeInsert:
			key, err := stableDataKey(*change.Schema, change.After)
			if err != nil {
				return err
			}
			s.rows[key] = MemoryRow{RelationID: change.Schema.ID, Row: change.After.Clone()}
		case ChangeUpdate:
			if len(change.Before) > 0 {
				key, err := stableDataKey(*change.Schema, change.Before)
				if err != nil {
					return err
				}
				delete(s.rows, key)
			}
			key, err := stableDataKey(*change.Schema, change.After)
			if err != nil {
				return err
			}
			s.rows[key] = MemoryRow{RelationID: change.Schema.ID, Row: change.After.Clone()}
		case ChangeDelete:
			row := change.Before
			if len(row) == 0 {
				row = change.After
			}
			key, err := stableDataKey(*change.Schema, row)
			if err != nil {
				return err
			}
			delete(s.rows, key)
		case ChangeTruncate:
			prefix := fmt.Sprintf("%d/", change.Schema.ID)
			for key := range s.rows {
				if len(key) >= len(prefix) && key[:len(prefix)] == prefix {
					delete(s.rows, key)
				}
			}
		case ChangeSchema:
			// Schema metadata is consumed by the coordinator; no data change.
		default:
			return fmt.Errorf("%w: unsupported change kind %s", ErrInvalidChange, change.Kind)
		}
		s.changeSeen[change.LSN] = struct{}{}
		s.changes = append(s.changes, change.Clone())
		if change.LSN > s.durableLSN {
			s.durableLSN = change.LSN
		}
	}
	return nil
}

// Rows returns a deterministic copy of the materialized data.
func (s *MemorySink) Rows() []MemoryRow {
	s.mu.Lock()
	defer s.mu.Unlock()
	keys := make([]string, 0, len(s.rows))
	for key := range s.rows {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	rows := make([]MemoryRow, 0, len(keys))
	for _, key := range keys {
		row := s.rows[key]
		row.Row = row.Row.Clone()
		rows = append(rows, row)
	}
	return rows
}

// AppliedChanges returns changes accepted by the sink in LSN order.
func (s *MemorySink) AppliedChanges() []Change {
	s.mu.Lock()
	defer s.mu.Unlock()
	changes := make([]Change, len(s.changes))
	for i, change := range s.changes {
		changes[i] = change.Clone()
	}
	return changes
}

// Calls reports how many snapshot and change batches were delivered.
func (s *MemorySink) Calls() (snapshot, changes int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshotCalls, s.changeCalls
}

// DurableLSN returns the highest change LSN the sink confirmed.
func (s *MemorySink) DurableLSN() LSN {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.durableLSN
}

func stableDataKey(relation Relation, row Row) (string, error) {
	key, err := relation.Key(row)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%d/%s", relation.ID, key.Encoded), nil
}

// ErrSinkNotConfirmed can be wrapped by a sink that cannot confirm durability.
var ErrSinkNotConfirmed = errors.New("dataeng: sink did not confirm")
