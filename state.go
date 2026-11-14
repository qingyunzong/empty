package dataeng

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
)

// StateFormatVersion is the on-disk checkpoint format.
const StateFormatVersion = 1

// State is the durable handoff checkpoint. It is written atomically only after
// the sink has confirmed the corresponding snapshot rows or WAL changes.
type State struct {
	FormatVersion       int             `json:"format_version"`
	SnapshotFingerprint string          `json:"snapshot_fingerprint"`
	Database            string          `json:"database,omitempty"`
	Slot                string          `json:"slot,omitempty"`
	ExportedSnapshot    string          `json:"exported_snapshot"`
	ConsistentPoint     LSN             `json:"consistent_point"`
	SnapshotComplete    bool            `json:"snapshot_complete"`
	FlushLSN            LSN             `json:"flush_lsn"`
	Relations           []RelationEntry `json:"relations"`
	// SnapshotRows maps canonical row keys to tuple digests. It is retained only
	// while the initial snapshot is incomplete so a crash can resume without
	// re-deduplicating against data already applied in this process.
	SnapshotRows map[string]string `json:"snapshot_rows,omitempty"`
}

func newInitialState(snapshot Snapshot, fingerprint string) State {
	relations := make([]RelationEntry, 0, len(snapshot.Relations))
	for _, relation := range sortedRelations(snapshot.Relations) {
		relations = append(relations, RelationEntry{
			Relation:     relation,
			EffectiveLSN: snapshot.ConsistentPoint,
		})
	}
	return State{
		FormatVersion:       StateFormatVersion,
		SnapshotFingerprint: fingerprint,
		Database:            snapshot.Database,
		Slot:                snapshot.Slot,
		ExportedSnapshot:    snapshot.ExportedSnapshot,
		ConsistentPoint:     snapshot.ConsistentPoint,
		SnapshotComplete:    false,
		FlushLSN:            InvalidLSN,
		Relations:           relations,
		SnapshotRows:        make(map[string]string),
	}
}

// Validate checks checkpoint invariants.
func (s State) Validate() error {
	if s.FormatVersion != StateFormatVersion {
		return fmt.Errorf("%w: unsupported format version %d", ErrInvalidState, s.FormatVersion)
	}
	if s.SnapshotFingerprint == "" {
		return fmt.Errorf("%w: missing snapshot fingerprint", ErrInvalidState)
	}
	if s.ExportedSnapshot == "" {
		return fmt.Errorf("%w: missing exported snapshot name", ErrInvalidState)
	}
	if !s.ConsistentPoint.IsValid() {
		return fmt.Errorf("%w: invalid consistent point", ErrInvalidState)
	}
	if len(s.Relations) == 0 {
		return fmt.Errorf("%w: no relation schemas", ErrInvalidState)
	}
	if !s.SnapshotComplete {
		if s.FlushLSN != InvalidLSN {
			return fmt.Errorf("%w: flush LSN must be zero before snapshot completion", ErrInvalidState)
		}
	} else if s.FlushLSN < s.ConsistentPoint {
		return fmt.Errorf("%w: flush LSN %s precedes consistent point %s",
			ErrInvalidState, s.FlushLSN, s.ConsistentPoint)
	}
	seen := make(map[[2]uint32]struct{}, len(s.Relations))
	for _, entry := range s.Relations {
		if err := entry.Relation.Validate(); err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidState, err)
		}
		if !entry.EffectiveLSN.IsValid() {
			return fmt.Errorf("%w: relation %d version %d has invalid effective LSN",
				ErrInvalidState, entry.Relation.ID, entry.Relation.Version)
		}
		if entry.EffectiveLSN > s.FlushLSN && s.SnapshotComplete {
			return fmt.Errorf("%w: relation %d version %d is effective beyond flush LSN",
				ErrInvalidState, entry.Relation.ID, entry.Relation.Version)
		}
		if entry.EffectiveLSN > s.ConsistentPoint && !s.SnapshotComplete {
			return fmt.Errorf("%w: relation %d version %d is effective beyond consistent point",
				ErrInvalidState, entry.Relation.ID, entry.Relation.Version)
		}
		key := [2]uint32{entry.Relation.ID, entry.Relation.Version}
		if _, exists := seen[key]; exists {
			return fmt.Errorf("%w: duplicate relation %d version %d",
				ErrInvalidState, entry.Relation.ID, entry.Relation.Version)
		}
		seen[key] = struct{}{}
	}
	if s.SnapshotRows != nil {
		for key, digest := range s.SnapshotRows {
			if key == "" || digest == "" {
				return fmt.Errorf("%w: malformed snapshot dedup entry", ErrInvalidState)
			}
		}
	}
	return nil
}

// Clone returns a deep copy of the state.
func (s State) Clone() State {
	clone := s
	clone.Relations = make([]RelationEntry, len(s.Relations))
	for i, entry := range s.Relations {
		clone.Relations[i] = RelationEntry{
			Relation:     entry.Relation.Clone(),
			EffectiveLSN: entry.EffectiveLSN,
		}
	}
	if s.SnapshotRows != nil {
		clone.SnapshotRows = make(map[string]string, len(s.SnapshotRows))
		for key, value := range s.SnapshotRows {
			clone.SnapshotRows[key] = value
		}
	}
	return clone
}

// Checksum returns the hex SHA-256 of the canonical JSON state.
func (s State) Checksum() (string, error) {
	data, err := json.Marshal(s)
	if err != nil {
		return "", fmt.Errorf("dataeng: marshal state for checksum: %w", err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// SortedSnapshotKeys returns dedup keys in a deterministic order.
func (s State) SortedSnapshotKeys() []string {
	keys := make([]string, 0, len(s.SnapshotRows))
	for key := range s.SnapshotRows {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// StateStore durably loads and saves the handoff checkpoint.
//
// Save must be atomic: after a crash, Load either sees the previous state or
// the new state, never a partial checkpoint.
type StateStore interface {
	Load(ctx context.Context) (State, error)
	Save(ctx context.Context, state State) error
}
