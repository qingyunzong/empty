package dataeng

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
)

// Snapshot binds an exported PostgreSQL snapshot to the logical replication
// position and relation schemas that the initial copy and subsequent WAL share.
//
// ConsistentPoint is the LSN from which WAL changes are applied. Relations are
// the schema versions visible in the exported snapshot.
type Snapshot struct {
	Database         string     `json:"database,omitempty"`
	Slot             string     `json:"slot,omitempty"`
	ExportedSnapshot string     `json:"exported_snapshot"`
	ConsistentPoint  LSN        `json:"consistent_point"`
	Relations        []Relation `json:"relations"`
}

// Validate checks the snapshot binding.
func (s Snapshot) Validate() error {
	if strings.TrimSpace(s.ExportedSnapshot) == "" {
		return fmt.Errorf("%w: exported snapshot name is required", ErrInvalidSnapshot)
	}
	if !s.ConsistentPoint.IsValid() {
		return fmt.Errorf("%w: consistent point must be a non-zero LSN", ErrInvalidSnapshot)
	}
	if len(s.Relations) == 0 {
		return fmt.Errorf("%w: at least one relation schema is required", ErrInvalidSnapshot)
	}
	seen := make(map[uint32]struct{}, len(s.Relations))
	for _, relation := range s.Relations {
		if err := relation.Validate(); err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidSnapshot, err)
		}
		if _, exists := seen[relation.ID]; exists {
			return fmt.Errorf("%w: relation %d has more than one initial schema version",
				ErrInvalidSnapshot, relation.ID)
		}
		seen[relation.ID] = struct{}{}
	}
	return nil
}

// Fingerprint returns a stable digest of every field that must remain bound
// across restarts.
func (s Snapshot) Fingerprint() (string, error) {
	if err := s.Validate(); err != nil {
		return "", err
	}
	type canonicalSnapshot struct {
		Database         string     `json:"database"`
		Slot             string     `json:"slot"`
		ExportedSnapshot string     `json:"exported_snapshot"`
		ConsistentPoint  LSN        `json:"consistent_point"`
		Relations        []Relation `json:"relations"`
	}
	payload, err := json.Marshal(canonicalSnapshot{
		Database:         s.Database,
		Slot:             s.Slot,
		ExportedSnapshot: s.ExportedSnapshot,
		ConsistentPoint:  s.ConsistentPoint,
		Relations:        sortedRelations(s.Relations),
	})
	if err != nil {
		return "", fmt.Errorf("dataeng: fingerprint snapshot: %w", err)
	}
	sum := sha256.Sum256(payload)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

// SnapshotRow is one full tuple read inside the exported snapshot.
type SnapshotRow struct {
	RelationID      uint32    `json:"relation_id"`
	RelationVersion uint32    `json:"relation_version"`
	Row             Row       `json:"row"`
	Schema          *Relation `json:"-"`
}

// ChangeKind classifies a decoded WAL change.
type ChangeKind uint8

const (
	// ChangeInsert inserts or upserts the After tuple.
	ChangeInsert ChangeKind = iota + 1
	// ChangeUpdate replaces Before (when present) with After.
	ChangeUpdate
	// ChangeDelete removes Before, falling back to After when Before is absent.
	ChangeDelete
	// ChangeTruncate removes all rows of the relation.
	ChangeTruncate
	// ChangeSchema introduces a new immutable relation schema version.
	ChangeSchema
)

// String returns a human-readable change kind.
func (k ChangeKind) String() string {
	switch k {
	case ChangeInsert:
		return "insert"
	case ChangeUpdate:
		return "update"
	case ChangeDelete:
		return "delete"
	case ChangeTruncate:
		return "truncate"
	case ChangeSchema:
		return "schema"
	default:
		return fmt.Sprintf("change-kind(%d)", uint8(k))
	}
}

// Change is one committed logical WAL change.
//
// LSN is the unique WAL position of this change and is the deduplication key.
// Sources must not emit multiple distinct changes with the same LSN. CommitLSN
// is optional transaction metadata and does not control the flush position:
// flushing only at record LSNs prevents a crash mid-transaction from skipping
// the remaining records.
//
// RelationVersion is mandatory for DML. The coordinator resolves that exact
// version and populates Schema before calling the sink, so a sink never has to
// guess whether a tuple predates or postdates a DDL.
type Change struct {
	LSN             LSN        `json:"lsn"`
	CommitLSN       LSN        `json:"commit_lsn,omitempty"`
	Kind            ChangeKind `json:"kind"`
	RelationID      uint32     `json:"relation_id,omitempty"`
	RelationVersion uint32     `json:"relation_version,omitempty"`
	Before          Row        `json:"before,omitempty"`
	After           Row        `json:"after,omitempty"`
	DDL             *Relation  `json:"ddl,omitempty"`
	Schema          *Relation  `json:"-"`
}

// Position returns the durable progress position represented by the change.
// It is deliberately the record LSN, not CommitLSN.
func (c Change) Position() LSN { return c.LSN }

// Clone returns a copy safe for a sink to retain.
func (c Change) Clone() Change {
	clone := c
	clone.Before = c.Before.Clone()
	clone.After = c.After.Clone()
	if c.DDL != nil {
		relation := c.DDL.Clone()
		clone.DDL = &relation
	}
	if c.Schema != nil {
		relation := c.Schema.Clone()
		clone.Schema = &relation
	}
	return clone
}

// Clone returns a copy safe for a sink to retain.
func (r SnapshotRow) Clone() SnapshotRow {
	clone := r
	clone.Row = r.Row.Clone()
	if r.Schema != nil {
		relation := r.Schema.Clone()
		clone.Schema = &relation
	}
	return clone
}
