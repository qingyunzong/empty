package dataeng

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
)

// DefaultBatchSize is used when Config.BatchSize is zero.
const DefaultBatchSize = 500

// Config wires the immutable snapshot binding to its readers, sink, and
// durable checkpoint store.
type Config struct {
	Snapshot Snapshot

	Store          StateStore
	SnapshotSource SnapshotSource
	WALSource      WALSource
	Sink           Sink

	// BatchSize bounds snapshot rows and WAL changes per sink call. Zero uses
	// DefaultBatchSize.
	BatchSize int
}

// Coordinator performs the initial snapshot copy and then follows WAL from the
// durable flush position. It is intended to have a single Run/RunWAL caller.
type Coordinator struct {
	config      Config
	fingerprint string

	mu       sync.RWMutex
	state    State
	hasState bool
}

// NewCoordinator validates config and computes the snapshot binding.
func NewCoordinator(config Config) (*Coordinator, error) {
	if err := config.Snapshot.Validate(); err != nil {
		return nil, err
	}
	if config.Store == nil {
		return nil, fmt.Errorf("%w: state store is required", ErrInvalidConfig)
	}
	if config.Sink == nil {
		return nil, fmt.Errorf("%w: sink is required", ErrInvalidConfig)
	}
	if config.BatchSize < 0 {
		return nil, fmt.Errorf("%w: batch size must not be negative", ErrInvalidConfig)
	}
	if config.BatchSize == 0 {
		config.BatchSize = DefaultBatchSize
	}
	fingerprint, err := config.Snapshot.Fingerprint()
	if err != nil {
		return nil, err
	}
	registry := NewRelationRegistry()
	for _, relation := range config.Snapshot.Relations {
		if err := registry.Add(relation, config.Snapshot.ConsistentPoint); err != nil {
			return nil, err
		}
	}
	return &Coordinator{config: config, fingerprint: fingerprint}, nil
}

// SnapshotFingerprint returns the binding digest persisted in every checkpoint.
func (c *Coordinator) SnapshotFingerprint() string { return c.fingerprint }

// State returns the last checkpoint observed by this coordinator. On a fresh
// coordinator it reports false until Run, RunSnapshot, or RunWAL loads state.
func (c *Coordinator) State() (State, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if !c.hasState {
		return State{}, false
	}
	return c.state.Clone(), true
}

// Run completes the initial snapshot if necessary, then streams WAL until the
// source returns io.EOF or ctx is cancelled.
func (c *Coordinator) Run(ctx context.Context) error {
	state, registry, err := c.loadOrInit(ctx)
	if err != nil {
		return err
	}
	if !state.SnapshotComplete {
		if c.config.SnapshotSource == nil {
			return fmt.Errorf("%w: snapshot source is required while the snapshot is incomplete", ErrInvalidConfig)
		}
		if err := c.runSnapshot(ctx, &state, registry); err != nil {
			return err
		}
	}
	if c.config.WALSource == nil {
		return fmt.Errorf("%w: WAL source is required", ErrInvalidConfig)
	}
	return c.runWAL(ctx, &state, registry)
}

// RunSnapshot performs only the initial snapshot copy. Calling it after the
// snapshot is complete is a no-op.
func (c *Coordinator) RunSnapshot(ctx context.Context) error {
	state, registry, err := c.loadOrInit(ctx)
	if err != nil {
		return err
	}
	if state.SnapshotComplete {
		c.remember(state)
		return nil
	}
	if c.config.SnapshotSource == nil {
		return fmt.Errorf("%w: snapshot source is required", ErrInvalidConfig)
	}
	return c.runSnapshot(ctx, &state, registry)
}

// RunWAL streams changes after the durable flush position. The snapshot must
// already be complete.
func (c *Coordinator) RunWAL(ctx context.Context) error {
	state, registry, err := c.loadOrInit(ctx)
	if err != nil {
		return err
	}
	if !state.SnapshotComplete {
		return fmt.Errorf("%w: initial snapshot is not complete", ErrInvalidState)
	}
	if c.config.WALSource == nil {
		return fmt.Errorf("%w: WAL source is required", ErrInvalidConfig)
	}
	return c.runWAL(ctx, &state, registry)
}

func (c *Coordinator) loadOrInit(ctx context.Context) (State, *RelationRegistry, error) {
	state, err := c.config.Store.Load(ctx)
	if errors.Is(err, ErrStateNotFound) {
		state = newInitialState(c.config.Snapshot, c.fingerprint)
		if err := state.Validate(); err != nil {
			return State{}, nil, err
		}
		if err := c.config.Store.Save(ctx, state); err != nil {
			return State{}, nil, fmt.Errorf("dataeng: persist initial state: %w", err)
		}
	} else if err != nil {
		return State{}, nil, err
	}
	if state.SnapshotFingerprint != c.fingerprint {
		return State{}, nil, fmt.Errorf("%w: fingerprint %s, expected %s",
			ErrSnapshotMismatch, state.SnapshotFingerprint, c.fingerprint)
	}
	if state.ExportedSnapshot != c.config.Snapshot.ExportedSnapshot ||
		state.ConsistentPoint != c.config.Snapshot.ConsistentPoint ||
		state.Database != c.config.Snapshot.Database ||
		state.Slot != c.config.Snapshot.Slot {
		return State{}, nil, fmt.Errorf("%w: persisted snapshot metadata differs from config", ErrSnapshotMismatch)
	}
	if err := state.Validate(); err != nil {
		return State{}, nil, err
	}
	registry := NewRelationRegistry()
	for _, entry := range state.Relations {
		if err := registry.Add(entry.Relation, entry.EffectiveLSN); err != nil {
			return State{}, nil, err
		}
	}
	for _, relation := range c.config.Snapshot.Relations {
		persisted, _, ok := registry.Resolve(relation.ID, relation.Version)
		if !ok || !persisted.Equal(relation) {
			return State{}, nil, fmt.Errorf("%w: persisted state is missing relation %d version %d",
				ErrSnapshotMismatch, relation.ID, relation.Version)
		}
	}
	c.remember(state)
	return state, registry, nil
}

func (c *Coordinator) runSnapshot(ctx context.Context, state *State, registry *RelationRegistry) error {
	reader, err := c.config.SnapshotSource.OpenSnapshot(ctx, c.config.Snapshot)
	if err != nil {
		return fmt.Errorf("dataeng: open snapshot: %w", err)
	}
	defer reader.Close()

	batch := make([]SnapshotRow, 0, c.config.BatchSize)
	pending := make(map[string]string)
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		if err := c.config.Sink.ApplySnapshot(ctx, batch); err != nil {
			return fmt.Errorf("dataeng: apply snapshot batch: %w", err)
		}
		if state.SnapshotRows == nil {
			state.SnapshotRows = make(map[string]string)
		}
		for key, digest := range pending {
			state.SnapshotRows[key] = digest
		}
		if err := c.config.Store.Save(ctx, *state); err != nil {
			return fmt.Errorf("dataeng: checkpoint snapshot: %w", err)
		}
		c.remember(*state)
		batch = batch[:0]
		pending = make(map[string]string)
		return nil
	}

	for {
		row, err := reader.Next(ctx)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("dataeng: read snapshot: %w", err)
		}
		prepared, key, digest, err := prepareSnapshotRow(row, registry, c.config.Snapshot.ConsistentPoint)
		if err != nil {
			return err
		}
		existing, seen := pending[key]
		if !seen {
			existing, seen = state.SnapshotRows[key]
		}
		if seen {
			if existing != digest {
				return fmt.Errorf("%w: key %s", ErrSnapshotRowConflict, key)
			}
			continue
		}
		pending[key] = digest
		batch = append(batch, prepared)
		if len(batch) >= c.config.BatchSize {
			if err := flush(); err != nil {
				return err
			}
		}
	}
	if err := flush(); err != nil {
		return err
	}

	state.SnapshotComplete = true
	state.FlushLSN = state.ConsistentPoint
	state.SnapshotRows = nil
	if err := state.Validate(); err != nil {
		return err
	}
	if err := c.config.Store.Save(ctx, *state); err != nil {
		return fmt.Errorf("dataeng: checkpoint completed snapshot: %w", err)
	}
	c.remember(*state)
	return nil
}

func prepareSnapshotRow(row SnapshotRow, registry *RelationRegistry, consistentPoint LSN) (SnapshotRow, string, string, error) {
	if row.RelationID == 0 || row.RelationVersion == 0 {
		return SnapshotRow{}, "", "", fmt.Errorf("%w: snapshot row has no relation identity", ErrInvalidRow)
	}
	schema, effective, ok := registry.Resolve(row.RelationID, row.RelationVersion)
	if !ok {
		return SnapshotRow{}, "", "", fmt.Errorf("%w: relation %d version %d",
			ErrRelationNotFound, row.RelationID, row.RelationVersion)
	}
	if effective > consistentPoint {
		return SnapshotRow{}, "", "", fmt.Errorf("%w: relation %d version %d effective at %s, after consistent point %s",
			ErrFutureRelationVersion, row.RelationID, row.RelationVersion, effective, consistentPoint)
	}
	if row.Schema != nil && !row.Schema.Equal(schema) {
		return SnapshotRow{}, "", "", fmt.Errorf("%w: snapshot row supplies a different schema for relation %d version %d",
			ErrInvalidRow, row.RelationID, row.RelationVersion)
	}
	if err := schema.ValidateRow(row.Row, true); err != nil {
		return SnapshotRow{}, "", "", err
	}
	key, err := schema.Key(row.Row)
	if err != nil {
		return SnapshotRow{}, "", "", err
	}
	digest, err := schema.RowHash(row.Row)
	if err != nil {
		return SnapshotRow{}, "", "", err
	}
	prepared := row.Clone()
	copiedSchema := schema.Clone()
	prepared.Schema = &copiedSchema
	return prepared, key.String(), digest, nil
}

func (c *Coordinator) runWAL(ctx context.Context, state *State, registry *RelationRegistry) error {
	reader, err := c.config.WALSource.OpenWAL(ctx, state.FlushLSN)
	if err != nil {
		return fmt.Errorf("dataeng: open WAL: %w", err)
	}
	defer reader.Close()

	committedRegistry := registry.Clone()
	workingRegistry := committedRegistry.Clone()
	batch := make([]Change, 0, c.config.BatchSize)
	seen := make(map[LSN]struct{})
	lastLSN := state.FlushLSN

	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		if err := c.config.Sink.ApplyChanges(ctx, batch); err != nil {
			return fmt.Errorf("dataeng: apply change batch: %w", err)
		}
		position := batch[len(batch)-1].Position()
		if position < state.FlushLSN {
			return fmt.Errorf("%w: batch position %s is below current flush %s",
				ErrFlushRegression, position, state.FlushLSN)
		}
		state.FlushLSN = position
		state.Relations = workingRegistry.Entries()
		if err := state.Validate(); err != nil {
			return err
		}
		if err := c.config.Store.Save(ctx, *state); err != nil {
			return fmt.Errorf("dataeng: checkpoint WAL: %w", err)
		}
		c.remember(*state)
		committedRegistry = workingRegistry.Clone()
		workingRegistry = committedRegistry.Clone()
		batch = batch[:0]
		for lsn := range seen {
			if lsn <= state.FlushLSN {
				delete(seen, lsn)
			}
		}
		return nil
	}

	for {
		change, err := reader.Next(ctx)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("dataeng: read WAL: %w", err)
		}
		if !change.LSN.IsValid() {
			return fmt.Errorf("%w: change has zero LSN", ErrInvalidChange)
		}
		if change.LSN <= state.FlushLSN {
			continue
		}
		if _, duplicate := seen[change.LSN]; duplicate {
			continue
		}
		if change.LSN < lastLSN {
			return fmt.Errorf("%w: %s after %s", ErrNonMonotonicLSN, change.LSN, lastLSN)
		}
		prepared, err := prepareChange(change, workingRegistry)
		if err != nil {
			return err
		}
		seen[prepared.LSN] = struct{}{}
		lastLSN = prepared.LSN
		batch = append(batch, prepared)
		if len(batch) >= c.config.BatchSize {
			if err := flush(); err != nil {
				return err
			}
		}
	}
	if err := flush(); err != nil {
		return err
	}
	c.remember(*state)
	return nil
}

func prepareChange(change Change, registry *RelationRegistry) (Change, error) {
	if change.CommitLSN.IsValid() && change.CommitLSN < change.LSN {
		return Change{}, fmt.Errorf("%w: change commit LSN %s precedes change LSN %s",
			ErrInvalidChange, change.CommitLSN, change.LSN)
	}
	switch change.Kind {
	case ChangeSchema:
		if change.DDL == nil {
			return Change{}, fmt.Errorf("%w: schema change at %s has no relation definition", ErrInvalidChange, change.LSN)
		}
		if len(change.Before) != 0 || len(change.After) != 0 {
			return Change{}, fmt.Errorf("%w: schema change at %s carries a tuple", ErrInvalidChange, change.LSN)
		}
		relation := change.DDL.Clone()
		if err := relation.Validate(); err != nil {
			return Change{}, err
		}
		if change.RelationID != 0 && change.RelationID != relation.ID {
			return Change{}, fmt.Errorf("%w: schema change relation ID %d does not match DDL %d",
				ErrInvalidChange, change.RelationID, relation.ID)
		}
		if change.RelationVersion != 0 && change.RelationVersion != relation.Version {
			return Change{}, fmt.Errorf("%w: schema change version %d does not match DDL version %d",
				ErrInvalidChange, change.RelationVersion, relation.Version)
		}
		if err := registry.Add(relation, change.LSN); err != nil {
			return Change{}, err
		}
		change.RelationID = relation.ID
		change.RelationVersion = relation.Version
		change.DDL = &relation
		change.Schema = &relation
		return change, nil
	case ChangeInsert, ChangeUpdate, ChangeDelete, ChangeTruncate:
		if change.DDL != nil {
			return Change{}, fmt.Errorf("%w: data change at %s carries a DDL definition", ErrInvalidChange, change.LSN)
		}
		if change.RelationID == 0 || change.RelationVersion == 0 {
			return Change{}, fmt.Errorf("%w: data change at %s has no relation version", ErrInvalidChange, change.LSN)
		}
		relation, effective, ok := registry.Resolve(change.RelationID, change.RelationVersion)
		if !ok {
			return Change{}, fmt.Errorf("%w: relation %d version %d at %s",
				ErrRelationNotFound, change.RelationID, change.RelationVersion, change.LSN)
		}
		if effective > change.LSN {
			return Change{}, fmt.Errorf("%w: relation %d version %d effective at %s, after change %s",
				ErrFutureRelationVersion, change.RelationID, change.RelationVersion, effective, change.LSN)
		}
		if change.Schema != nil && !change.Schema.Equal(relation) {
			return Change{}, fmt.Errorf("%w: change supplies a different schema for relation %d version %d",
				ErrInvalidChange, change.RelationID, change.RelationVersion)
		}
		switch change.Kind {
		case ChangeInsert:
			if len(change.After) == 0 {
				return Change{}, fmt.Errorf("%w: insert at %s has no After tuple", ErrInvalidChange, change.LSN)
			}
			if err := relation.ValidateRow(change.After, false); err != nil {
				return Change{}, err
			}
		case ChangeUpdate:
			if len(change.After) == 0 {
				return Change{}, fmt.Errorf("%w: update at %s has no After tuple", ErrInvalidChange, change.LSN)
			}
			if err := relation.ValidateRow(change.After, false); err != nil {
				return Change{}, err
			}
			if len(change.Before) != 0 {
				if err := relation.ValidateRow(change.Before, false); err != nil {
					return Change{}, err
				}
			}
		case ChangeDelete:
			row := change.Before
			if len(row) == 0 {
				row = change.After
			}
			if len(row) == 0 {
				return Change{}, fmt.Errorf("%w: delete at %s has no key tuple", ErrInvalidChange, change.LSN)
			}
			if err := relation.ValidateRow(row, false); err != nil {
				return Change{}, err
			}
		case ChangeTruncate:
			if len(change.Before) != 0 || len(change.After) != 0 {
				return Change{}, fmt.Errorf("%w: truncate at %s carries a tuple", ErrInvalidChange, change.LSN)
			}
		}
		schema := relation.Clone()
		change.Schema = &schema
		return change, nil
	default:
		return Change{}, fmt.Errorf("%w: unknown change kind %d at %s",
			ErrInvalidChange, change.Kind, change.LSN)
	}
}

func (c *Coordinator) remember(state State) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.state = state.Clone()
	c.hasState = true
}
