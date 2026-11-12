package dataeng

import (
	"fmt"
	"sort"
)

// OpKind identifies a batch operation.
type OpKind uint8

const (
	// OpInsert inserts a complete new row.
	OpInsert OpKind = iota + 1
	// OpUpdate updates one old row.
	OpUpdate
	// OpDelete deletes one old row.
	OpDelete
)

const (
	// Insert is an alias for OpInsert.
	Insert = OpInsert
	// Update is an alias for OpUpdate.
	Update = OpUpdate
	// Delete is an alias for OpDelete.
	Delete = OpDelete
)

// String returns a readable name for the operation kind.
func (k OpKind) String() string {
	switch k {
	case OpInsert:
		return "insert"
	case OpUpdate:
		return "update"
	case OpDelete:
		return "delete"
	default:
		return fmt.Sprintf("opkind(%d)", k)
	}
}

// Operation is one insert, update or delete.
//
// OldID addresses the pre-batch row for updates and deletes. Before, when
// non-nil, is an optional partial or complete old-row image whose provided
// fields must match the old row exactly; an absent or CellMissing field is not
// checked and CellUnchanged is invalid there. After is a complete row for
// inserts and a partial after-image for updates; it must be empty for deletes.
type Operation struct {
	Kind   OpKind
	OldID  Cell
	Before Row
	After  Row
}

// InsertOp builds an insert operation.
func InsertOp(after Row) Operation {
	return Operation{Kind: OpInsert, After: after}
}

// UpdateOp builds an update operation addressed by oldID. before may be nil.
func UpdateOp(oldID Cell, before, after Row) Operation {
	return Operation{Kind: OpUpdate, OldID: oldID, Before: before, After: after}
}

// DeleteOp builds a delete operation addressed by oldID. before may be nil.
func DeleteOp(oldID Cell, before Row) Operation {
	return Operation{Kind: OpDelete, OldID: oldID, Before: before}
}

// Batch is an ordered group of operations applied atomically.
type Batch struct {
	Operations []Operation
}

// NewBatch returns a batch containing operations.
func NewBatch(operations ...Operation) Batch {
	return Batch{Operations: operations}
}

// ChangeKind identifies a net row change.
type ChangeKind uint8

const (
	// ChangeInsert means the primary key is present only in the new table.
	ChangeInsert ChangeKind = iota + 1
	// ChangeUpdate means the same primary key exists in old and new tables but
	// the row content differs.
	ChangeUpdate
	// ChangeDelete means the primary key is present only in the old table.
	ChangeDelete
)

const (
	// Inserted is an alias for ChangeInsert.
	Inserted = ChangeInsert
	// Updated is an alias for ChangeUpdate.
	Updated = ChangeUpdate
	// Deleted is an alias for ChangeDelete.
	Deleted = ChangeDelete
)

// String returns a readable name for the change kind.
func (k ChangeKind) String() string {
	switch k {
	case ChangeInsert:
		return "insert"
	case ChangeUpdate:
		return "update"
	case ChangeDelete:
		return "delete"
	default:
		return fmt.Sprintf("changekind(%d)", k)
	}
}

// FieldSource says where a field in a resulting row came from.
type FieldSource uint8

const (
	// SourceOld means the field was copied from the old row mirror.
	SourceOld FieldSource = iota + 1
	// SourceAfter means the field came from an operation's after-image.
	SourceAfter
)

const (
	// FromOld is an alias for SourceOld.
	FromOld = SourceOld
	// FromAfter is an alias for SourceAfter.
	FromAfter = SourceAfter
)

// String returns a readable name for the field source.
func (s FieldSource) String() string {
	switch s {
	case SourceOld:
		return "old"
	case SourceAfter:
		return "after"
	default:
		return fmt.Sprintf("fieldsource(%d)", s)
	}
}

// Change describes a net row-level change.
//
// Before and After are complete row images. OldID is missing for inserts;
// NewID is missing for deletes. Sources has one entry for every column present
// in the change's resulting row (or in Before for deletes).
type Change struct {
	Kind    ChangeKind
	OldID   Cell
	NewID   Cell
	Before  Row
	After   Row
	Sources map[string]FieldSource
}

// Source returns the field source recorded for column.
func (c Change) Source(column string) (FieldSource, bool) {
	source, ok := c.Sources[column]
	return source, ok
}

// Result is the outcome of applying a batch.
//
// Table is the new immutable snapshot. Changes are the net differences between
// the old and new tables, ordered by primary key; no-op updates are omitted.
// Applied contains one entry per batch operation in input order, even when an
// operation does not change the final table.
type Result struct {
	Table   *Table
	Changes []Change
	Applied []Change
}

// Inserted returns the net insert changes.
func (r *Result) Inserted() []Change {
	return r.filter(ChangeInsert)
}

// Updated returns the net update changes.
func (r *Result) Updated() []Change {
	return r.filter(ChangeUpdate)
}

// Deleted returns the net delete changes.
func (r *Result) Deleted() []Change {
	return r.filter(ChangeDelete)
}

func (r *Result) filter(kind ChangeKind) []Change {
	if r == nil {
		return nil
	}
	var out []Change
	for _, change := range r.Changes {
		if change.Kind == kind {
			out = append(out, change)
		}
	}
	return out
}

// Apply applies batch atomically and returns the new snapshot and changes.
//
// All operations are validated before anything is published. The receiver is
// never modified: on any validation or conflict error the batch is rolled back
// by virtue of no result table being produced.
func (t *Table) Apply(batch Batch) (*Result, error) {
	if t == nil {
		return nil, fmt.Errorf("%w: nil table", ErrInvalidBatch)
	}
	if err := t.schema.Validate(); err != nil {
		return nil, err
	}

	schema := t.schema
	cols := schema.columnMap()
	staged := make([]stagedOperation, 0, len(batch.Operations))
	seenOld := make(map[string]int, len(batch.Operations))
	removed := make(map[string]struct{}, len(batch.Operations))

	for i, op := range batch.Operations {
		switch op.Kind {
		case OpInsert:
			if !op.OldID.IsMissing() {
				return nil, fmt.Errorf("%w: operation %d: insert must not specify an old primary key", ErrInvalidBatch, i)
			}
			if len(op.Before) != 0 {
				return nil, fmt.Errorf("%w: operation %d: insert must not carry a before image", ErrInvalidBatch, i)
			}
			row, err := buildInsertedRow(schema, cols, op.After)
			if err != nil {
				return nil, fmt.Errorf("%w: operation %d: %w", ErrInvalidBatch, i, err)
			}
			staged = append(staged, stagedOperation{
				index:   i,
				kind:    OpInsert,
				newID:   row[schema.PrimaryKey].Clone(),
				newRow:  row,
				sources: allSources(schema, SourceAfter),
			})

		case OpUpdate, OpDelete:
			oldID, oldRow, err := t.lookupOldRow(i, op.OldID)
			if err != nil {
				return nil, err
			}
			key := oldID.canonicalKey()
			if first, seen := seenOld[key]; seen {
				return nil, fmt.Errorf("%w: operation %d: old row %s was already referenced by operation %d", ErrConflict, i, oldID, first)
			}
			seenOld[key] = i
			removed[key] = struct{}{}

			if err := validateBefore(cols, oldRow, op.Before, i); err != nil {
				return nil, err
			}

			if op.Kind == OpDelete {
				if len(op.After) != 0 {
					return nil, fmt.Errorf("%w: operation %d: delete must not carry an after image", ErrInvalidBatch, i)
				}
				staged = append(staged, stagedOperation{
					index:   i,
					kind:    OpDelete,
					oldID:   oldID.Clone(),
					oldRow:  cloneRow(oldRow),
					sources: allSources(schema, SourceOld),
				})
				continue
			}

			newRow, sources, err := buildUpdatedRow(schema, cols, oldRow, op.After, i)
			if err != nil {
				return nil, err
			}
			staged = append(staged, stagedOperation{
				index:   i,
				kind:    OpUpdate,
				oldID:   oldID.Clone(),
				oldRow:  cloneRow(oldRow),
				newID:   newRow[schema.PrimaryKey].Clone(),
				newRow:  newRow,
				sources: sources,
			})

		default:
			return nil, fmt.Errorf("%w: operation %d: unknown operation kind %d", ErrInvalidBatch, i, op.Kind)
		}
	}

	// Publish only after every operation has passed validation. Every old row
	// addressed by an update/delete is removed first, which permits primary
	// key swaps and reuse of keys deleted by this same batch.
	final := make(map[string]Row, len(t.rows)+len(staged))
	finalSources := make(map[string]map[string]FieldSource, len(t.rows)+len(staged))
	for key, row := range t.rows {
		if _, ok := removed[key]; ok {
			continue
		}
		final[key] = cloneRow(row)
		finalSources[key] = allSources(schema, SourceOld)
	}
	for _, op := range staged {
		if op.kind == OpDelete {
			continue
		}
		key := op.newID.canonicalKey()
		if _, exists := final[key]; exists {
			return nil, fmt.Errorf("%w: operation %d: final primary key %s duplicates another row", ErrConflict, op.index, op.newID)
		}
		final[key] = cloneRow(op.newRow)
		finalSources[key] = cloneSources(op.sources)
	}

	newTable := &Table{
		schema: schema.Clone(),
		rows:   final,
	}
	return &Result{
		Table:   newTable,
		Changes: netChanges(t, newTable, finalSources),
		Applied: appliedChanges(staged),
	}, nil
}

// ApplyOperations is a convenience wrapper around Apply.
func (t *Table) ApplyOperations(operations []Operation) (*Result, error) {
	return t.Apply(Batch{Operations: operations})
}

// Apply is a package-level convenience wrapper.
func Apply(t *Table, batch Batch) (*Result, error) {
	return t.Apply(batch)
}

type stagedOperation struct {
	index   int
	kind    OpKind
	oldID   Cell
	oldRow  Row
	newID   Cell
	newRow  Row
	sources map[string]FieldSource
}

func (t *Table) lookupOldRow(index int, oldID Cell) (Cell, Row, error) {
	primary, _ := t.schema.PrimaryColumn()
	if !oldID.IsConcrete() {
		return Cell{}, nil, fmt.Errorf("%w: operation %d: old primary key must be a concrete value, got %s", ErrInvalidBatch, index, oldID)
	}
	if err := validateConcreteCell(oldID, primary); err != nil {
		return Cell{}, nil, fmt.Errorf("%w: operation %d: old primary key %s: %v", ErrInvalidBatch, index, oldID, err)
	}
	row, ok := t.rows[oldID.canonicalKey()]
	if !ok {
		return Cell{}, nil, fmt.Errorf("%w: operation %d: old row %s: %w", ErrInvalidBatch, index, oldID, ErrMissingRow)
	}
	return oldID, row, nil
}

func validateBefore(cols map[string]Column, oldRow, before Row, index int) error {
	for id, cell := range before {
		if _, ok := cols[id]; !ok {
			return fmt.Errorf("%w: operation %d: before image contains unknown column %q", ErrInvalidBatch, index, id)
		}
		switch cell.Kind {
		case CellMissing:
			continue
		case CellUnchanged:
			return fmt.Errorf("%w: operation %d: before image column %q is marked unchanged", ErrInvalidBatch, index, id)
		case CellNull, CellInt64, CellBytes:
			if !cell.Equal(oldRow[id]) {
				return fmt.Errorf("%w: operation %d: before image column %q does not match old row: got %s, want %s",
					ErrBadBefore, index, id, cell, oldRow[id])
			}
		default:
			return fmt.Errorf("%w: operation %d: before image column %q has unknown cell kind %d", ErrInvalidBatch, index, id, cell.Kind)
		}
	}
	return nil
}

func buildInsertedRow(schema Schema, cols map[string]Column, after Row) (Row, error) {
	for id := range after {
		if _, ok := cols[id]; !ok {
			return nil, fmt.Errorf("%w: insert contains unknown column %q", ErrInvalidBatch, id)
		}
	}
	row := make(Row, len(schema.Columns))
	for _, col := range schema.Columns {
		cell, ok := after[col.ID]
		if !ok {
			return nil, fmt.Errorf("%w: insert is missing column %q", ErrInvalidBatch, col.ID)
		}
		switch cell.Kind {
		case CellMissing, CellUnchanged:
			return nil, fmt.Errorf("%w: insert column %q must be concrete, got %s", ErrInvalidBatch, col.ID, cell.Kind)
		case CellNull, CellInt64, CellBytes:
			if err := validateConcreteCell(cell, col); err != nil {
				return nil, fmt.Errorf("%w: insert column %q: %v", ErrInvalidBatch, col.ID, err)
			}
		default:
			return nil, fmt.Errorf("%w: insert column %q has unknown cell kind %d", ErrInvalidBatch, col.ID, cell.Kind)
		}
		row[col.ID] = cell.Clone()
	}
	return row, nil
}

func buildUpdatedRow(schema Schema, cols map[string]Column, oldRow, after Row, index int) (Row, map[string]FieldSource, error) {
	for id, cell := range after {
		if _, ok := cols[id]; !ok {
			return nil, nil, fmt.Errorf("%w: operation %d: after image contains unknown column %q", ErrInvalidBatch, index, id)
		}
		switch cell.Kind {
		case CellMissing, CellUnchanged, CellNull, CellInt64, CellBytes:
		default:
			return nil, nil, fmt.Errorf("%w: operation %d: after image column %q has unknown cell kind %d", ErrInvalidBatch, index, id, cell.Kind)
		}
		if cell.IsConcrete() {
			if err := validateConcreteCell(cell, cols[id]); err != nil {
				return nil, nil, fmt.Errorf("%w: operation %d: after image column %q: %v", ErrInvalidBatch, index, id, err)
			}
		}
	}

	row := make(Row, len(schema.Columns))
	sources := make(map[string]FieldSource, len(schema.Columns))
	for _, col := range schema.Columns {
		cell, present := after[col.ID]
		if present && cell.IsConcrete() {
			row[col.ID] = cell.Clone()
			sources[col.ID] = SourceAfter
		} else {
			row[col.ID] = oldRow[col.ID].Clone()
			sources[col.ID] = SourceOld
		}
	}
	clean, err := validateCompleteRow(schema, cols, row, fmt.Sprintf("operation %d updated row", index))
	if err != nil {
		return nil, nil, fmt.Errorf("%w: operation %d: %w", ErrInvalidBatch, index, err)
	}
	return clean, sources, nil
}

func appliedChanges(staged []stagedOperation) []Change {
	out := make([]Change, 0, len(staged))
	for _, op := range staged {
		change := Change{
			Sources: cloneSources(op.sources),
		}
		switch op.kind {
		case OpInsert:
			change.Kind = ChangeInsert
			change.OldID = MissingCell()
			change.NewID = op.newID.Clone()
			change.After = cloneRow(op.newRow)
		case OpUpdate:
			change.Kind = ChangeUpdate
			change.OldID = op.oldID.Clone()
			change.NewID = op.newID.Clone()
			change.Before = cloneRow(op.oldRow)
			change.After = cloneRow(op.newRow)
		case OpDelete:
			change.Kind = ChangeDelete
			change.OldID = op.oldID.Clone()
			change.NewID = MissingCell()
			change.Before = cloneRow(op.oldRow)
		}
		out = append(out, change)
	}
	return out
}

func netChanges(oldTable, newTable *Table, finalSources map[string]map[string]FieldSource) []Change {
	schema := oldTable.schema
	type netEntry struct {
		id     Cell
		change Change
	}
	entries := make([]netEntry, 0, len(oldTable.rows)+len(newTable.rows))

	for key, oldRow := range oldTable.rows {
		newRow, ok := newTable.rows[key]
		if !ok {
			entries = append(entries, netEntry{
				id: oldRow[schema.PrimaryKey],
				change: Change{
					Kind:    ChangeDelete,
					OldID:   oldRow[schema.PrimaryKey].Clone(),
					NewID:   MissingCell(),
					Before:  cloneRow(oldRow),
					Sources: allSources(schema, SourceOld),
				},
			})
			continue
		}
		if oldRow.Equal(newRow) {
			continue
		}
		entries = append(entries, netEntry{
			id: newRow[schema.PrimaryKey],
			change: Change{
				Kind:    ChangeUpdate,
				OldID:   oldRow[schema.PrimaryKey].Clone(),
				NewID:   newRow[schema.PrimaryKey].Clone(),
				Before:  cloneRow(oldRow),
				After:   cloneRow(newRow),
				Sources: cloneSources(finalSources[key]),
			},
		})
	}

	for key, newRow := range newTable.rows {
		if _, ok := oldTable.rows[key]; ok {
			continue
		}
		entries = append(entries, netEntry{
			id: newRow[schema.PrimaryKey],
			change: Change{
				Kind:    ChangeInsert,
				OldID:   MissingCell(),
				NewID:   newRow[schema.PrimaryKey].Clone(),
				After:   cloneRow(newRow),
				Sources: cloneSources(finalSources[key]),
			},
		})
	}

	sort.SliceStable(entries, func(i, j int) bool {
		return compareCells(entries[i].id, entries[j].id) < 0
	})
	out := make([]Change, len(entries))
	for i, e := range entries {
		out[i] = e.change
	}
	return out
}
