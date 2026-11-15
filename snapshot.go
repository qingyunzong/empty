package dataeng

import (
	"fmt"
	"sort"
)

// SnapshotVersion is the current snapshot layout version.
const SnapshotVersion = 1

// Snapshot is a portable copy of an Engine's schemas, rows and applied
// transaction ledger. Persisting it between CDC checkpoints allows recovery to
// recognize a replayed transaction and return the original migration IDs.
type Snapshot struct {
	Version      int                   `json:"version"`
	Schemas      []Schema              `json:"schemas"`
	Rows         []SnapshotRow         `json:"rows"`
	Transactions []SnapshotTransaction `json:"transactions"`
}

// SnapshotRow is one materialized row.
type SnapshotRow struct {
	Table      string `json:"table"`
	Generation uint64 `json:"generation"`
	Image      Image  `json:"image"`
}

// SnapshotTransaction is one entry in the replay ledger.
type SnapshotTransaction struct {
	ID          string `json:"id"`
	Fingerprint string `json:"fingerprint"`
	Result      Result `json:"result"`
}

// Snapshot returns an independent copy of the engine state.
func (e *Engine) Snapshot() Snapshot {
	e.mu.Lock()
	defer e.mu.Unlock()

	snapshot := Snapshot{Version: SnapshotVersion}

	tableKeys := make([]tableGeneration, 0, len(e.schemas))
	for tableKey := range e.schemas {
		tableKeys = append(tableKeys, tableKey)
	}
	sort.Slice(tableKeys, func(i, j int) bool {
		if tableKeys[i].Table != tableKeys[j].Table {
			return tableKeys[i].Table < tableKeys[j].Table
		}
		return tableKeys[i].Generation < tableKeys[j].Generation
	})
	for _, tableKey := range tableKeys {
		snapshot.Schemas = append(snapshot.Schemas, cloneSchema(e.schemas[tableKey]))
	}

	rowKeys := make([]tableGeneration, 0, len(e.rows))
	for tableKey := range e.rows {
		rowKeys = append(rowKeys, tableKey)
	}
	sort.Slice(rowKeys, func(i, j int) bool {
		if rowKeys[i].Table != rowKeys[j].Table {
			return rowKeys[i].Table < rowKeys[j].Table
		}
		return rowKeys[i].Generation < rowKeys[j].Generation
	})
	for _, tableKey := range rowKeys {
		rows := e.rows[tableKey]
		keys := make([]string, 0, len(rows))
		for key := range rows {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			snapshot.Rows = append(snapshot.Rows, SnapshotRow{
				Table:      tableKey.Table,
				Generation: tableKey.Generation,
				Image:      rows[key].Clone(),
			})
		}
	}

	transactionIDs := make([]string, 0, len(e.transactions))
	for transactionID := range e.transactions {
		transactionIDs = append(transactionIDs, transactionID)
	}
	sort.Strings(transactionIDs)
	for _, transactionID := range transactionIDs {
		record := e.transactions[transactionID]
		snapshot.Transactions = append(snapshot.Transactions, SnapshotTransaction{
			ID:          transactionID,
			Fingerprint: record.fingerprint,
			Result:      record.result.clone(),
		})
	}
	return snapshot
}

// Restore replaces the receiver's state with a snapshot. Restore is atomic:
// an invalid snapshot leaves the receiver unchanged.
func (e *Engine) Restore(snapshot Snapshot) error {
	if snapshot.Version != 0 && snapshot.Version != SnapshotVersion {
		return fmt.Errorf("%w: unsupported snapshot version %d", ErrInvalidTransaction, snapshot.Version)
	}

	schemas := make(map[tableGeneration]Schema, len(snapshot.Schemas))
	for _, raw := range snapshot.Schemas {
		schema, err := normalizeSchema(raw)
		if err != nil {
			return err
		}
		tableKey := tableGeneration{Table: schema.Table, Generation: schema.Generation}
		if existing, ok := schemas[tableKey]; ok && !sameSchema(existing, schema) {
			return fmt.Errorf("%w: snapshot repeats table %q generation %d with different schemas",
				ErrInvalidSchema, schema.Table, schema.Generation)
		}
		schemas[tableKey] = schema
	}

	rows := make(map[tableGeneration]map[string]Image)
	identities := make(map[string]map[string]struct{})
	for _, raw := range snapshot.Rows {
		tableKey := tableGeneration{Table: raw.Table, Generation: raw.Generation}
		schema, ok := schemas[tableKey]
		if !ok {
			return fmt.Errorf("%w: snapshot row references unregistered table %q generation %d",
				ErrSchemaNotFound, raw.Table, raw.Generation)
		}
		if raw.Image == nil {
			return fmt.Errorf("%w: snapshot row for table %q generation %d has no image",
				ErrInvalidTransaction, raw.Table, raw.Generation)
		}
		_, keyID, err := makeKey(schema, raw.Image, "snapshot row")
		if err != nil {
			return err
		}
		if rows[tableKey] == nil {
			rows[tableKey] = make(map[string]Image)
		}
		if identities[raw.Table] == nil {
			identities[raw.Table] = make(map[string]struct{})
		}
		if _, exists := identities[raw.Table][keyID]; exists {
			return fmt.Errorf("%w: snapshot repeats a row for table %q across generations",
				ErrUniqueViolation, raw.Table)
		}
		if _, exists := rows[tableKey][keyID]; exists {
			return fmt.Errorf("%w: snapshot repeats a row for table %q generation %d",
				ErrUniqueViolation, raw.Table, raw.Generation)
		}
		identities[raw.Table][keyID] = struct{}{}
		rows[tableKey][keyID] = raw.Image.Clone()
	}

	transactions := make(map[string]transactionRecord, len(snapshot.Transactions))
	for _, raw := range snapshot.Transactions {
		if raw.ID == "" || raw.Fingerprint == "" {
			return fmt.Errorf("%w: snapshot transaction has an empty ID or fingerprint", ErrInvalidTransaction)
		}
		if _, exists := transactions[raw.ID]; exists {
			return fmt.Errorf("%w: snapshot repeats transaction %q", ErrTransactionConflict, raw.ID)
		}
		if raw.Result.TransactionID != "" && raw.Result.TransactionID != raw.ID {
			return fmt.Errorf("%w: snapshot transaction %q contains a result for %q",
				ErrInvalidTransaction, raw.ID, raw.Result.TransactionID)
		}
		result := raw.Result.clone()
		result.TransactionID = raw.ID
		transactions[raw.ID] = transactionRecord{
			fingerprint: raw.Fingerprint,
			result:      result,
		}
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	e.schemas = schemas
	e.rows = rows
	e.transactions = transactions
	return nil
}

// NewEngineFromSnapshot creates an engine initialized from a snapshot.
func NewEngineFromSnapshot(snapshot Snapshot) (*Engine, error) {
	engine := NewEngine()
	if err := engine.Restore(snapshot); err != nil {
		return nil, err
	}
	return engine, nil
}
