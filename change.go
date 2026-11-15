package dataeng

import (
	"bytes"
	"errors"
	"fmt"
	"reflect"
	"sort"
)

// Operation is the value of the SQL Server __$operation column.
type Operation int

const (
	// OperationDelete is a delete (operation 1).
	OperationDelete Operation = 1
	// OperationInsert is an insert (operation 2).
	OperationInsert Operation = 2
	// OperationUpdateBefore is the before image of an update (operation 3).
	OperationUpdateBefore Operation = 3
	// OperationUpdateAfter is the after image of an update (operation 4).
	OperationUpdateAfter Operation = 4

	// Short aliases used by CDC documentation.
	OperationDeleteOld = OperationDelete
	OperationInsertNew = OperationInsert
	OperationUpdateOld = OperationUpdateBefore
	OperationUpdateNew = OperationUpdateAfter

	// OpDelete, OpInsert, OpUpdateBefore, and OpUpdateAfter are short aliases.
	OpDelete       = OperationDelete
	OpInsert       = OperationInsert
	OpUpdateBefore = OperationUpdateBefore
	OpUpdateAfter  = OperationUpdateAfter
)

// String returns a stable operation name.
func (o Operation) String() string {
	switch o {
	case OperationDelete:
		return "delete"
	case OperationInsert:
		return "insert"
	case OperationUpdateBefore:
		return "update_before"
	case OperationUpdateAfter:
		return "update_after"
	default:
		return fmt.Sprintf("operation(%d)", int(o))
	}
}

// ChangeKind describes the logical effect of a combined change.
type ChangeKind string

const (
	KindInsert ChangeKind = "insert"
	KindUpdate ChangeKind = "update"
	KindDelete ChangeKind = "delete"
)

// Position identifies a single SQL Server CDC change row. SQL Server emits an
// update as two rows with the same StartLSN and SeqVal, distinguished by
// Operation (3 and 4). UpdateMask is part of the identity so a replayed state
// row cannot overwrite a different projection of the same update.
type Position struct {
	StartLSN   LSN       `json:"start_lsn"`
	SeqVal     LSN       `json:"seqval"`
	Operation  Operation `json:"operation"`
	UpdateMask []byte    `json:"update_mask,omitempty"`
}

// ChangeKey is an alias for Position.
type ChangeKey = Position

// RowPosition is an alias for Position.
type RowPosition = Position

// ComparePositions orders positions by start LSN, seqval, operation, and
// update mask. The operation tie-breaker ensures an update's operation-3 row
// sorts before its operation-4 row.
func ComparePositions(a, b Position) int {
	if cmp := CompareLSN(a.StartLSN, b.StartLSN); cmp != 0 {
		return cmp
	}
	if cmp := CompareLSN(a.SeqVal, b.SeqVal); cmp != 0 {
		return cmp
	}
	if a.Operation < b.Operation {
		return -1
	}
	if a.Operation > b.Operation {
		return 1
	}
	return bytes.Compare(a.UpdateMask, b.UpdateMask)
}

// Compare orders two positions.
func (p Position) Compare(other Position) int {
	return ComparePositions(p, other)
}

// Equal reports whether two positions are identical.
func (p Position) Equal(other Position) bool {
	return ComparePositions(p, other) == 0
}

// IsZero reports whether the position has no LSN.
func (p Position) IsZero() bool {
	return p.StartLSN.IsZero() && p.SeqVal.IsZero()
}

// RowKey identifies the source row change within a transaction. Update before
// and after images share this key.
func (p Position) RowKey() string {
	return string(p.StartLSN) + "\x00" + string(p.SeqVal)
}

// ChangeRow is one row returned by cdc.fn_cdc_get_all_changes_<capture>.
// Values contains the captured source columns; SQL Server metadata columns are
// carried in the explicit fields above.
type ChangeRow struct {
	StartLSN   LSN            `json:"start_lsn"`
	SeqVal     LSN            `json:"seqval"`
	Operation  Operation      `json:"operation"`
	UpdateMask []byte         `json:"update_mask,omitempty"`
	Values     map[string]any `json:"values,omitempty"`

	// Row is an optional alias for Values. Values takes precedence when both
	// are set.
	Row map[string]any `json:"row,omitempty"`
}

// ClientValues returns the row values, accepting either Values or its Row
// alias.
func (r ChangeRow) ClientValues() map[string]any {
	if r.Values != nil {
		return r.Values
	}
	return r.Row
}

// Position returns the row's CDC position.
func (r ChangeRow) Position() Position {
	return Position{
		StartLSN:   r.StartLSN,
		SeqVal:     r.SeqVal,
		Operation:  r.Operation,
		UpdateMask: append([]byte(nil), r.UpdateMask...),
	}
}

// Change is a logical insert, update, or delete. For updates, Before and
// After are the two images emitted by SQL Server, and ChangedColumns lists
// the columns selected by __$update_mask (when column order is known).
type Change struct {
	StartLSN       LSN            `json:"start_lsn"`
	SeqVal         LSN            `json:"seqval"`
	Kind           ChangeKind     `json:"kind"`
	Operation      Operation      `json:"operation"`
	UpdateMask     []byte         `json:"update_mask,omitempty"`
	Before         map[string]any `json:"before,omitempty"`
	After          map[string]any `json:"after,omitempty"`
	ChangedColumns []string       `json:"changed_columns,omitempty"`
}

// RowChange is an alias for Change.
type RowChange = Change

// Position returns the position of the effective (after) row.
func (c Change) Position() Position {
	return Position{
		StartLSN:   c.StartLSN,
		SeqVal:     c.SeqVal,
		Operation:  c.Operation,
		UpdateMask: append([]byte(nil), c.UpdateMask...),
	}
}

var (
	// ErrIncompleteUpdate is returned when an operation-3 row has no matching
	// operation-4 row.
	ErrIncompleteUpdate = errors.New("sqlserver cdc: update before image has no after image")
	// ErrUnknownOperation is returned for operation values outside 1..4.
	ErrUnknownOperation = errors.New("sqlserver cdc: unknown CDC operation")
	// ErrConflictingChange is returned when two rows have the same complete
	// position but different values.
	ErrConflictingChange = errors.New("sqlserver cdc: conflicting duplicate change")
)

// CombineChanges merges operation-3 and operation-4 rows into one update,
// converts inserts/deletes into changes, removes exact replays, and sorts the
// result by (start_lsn, seqval, operation, update_mask).
func CombineChanges(rows []ChangeRow) ([]Change, error) {
	return CombineChangesWithColumns(rows, nil)
}

// Combine is an alias for CombineChanges.
func Combine(rows []ChangeRow) ([]Change, error) {
	return CombineChanges(rows)
}

// CombineChangesWithColumns is CombineChanges with the captured column order,
// used to translate __$update_mask bits into column names.
func CombineChangesWithColumns(rows []ChangeRow, columnOrder []string) ([]Change, error) {
	sorted := make([]ChangeRow, len(rows))
	copy(sorted, rows)
	sort.SliceStable(sorted, func(i, j int) bool {
		return ComparePositions(sorted[i].Position(), sorted[j].Position()) < 0
	})

	type updateGroup struct {
		before *ChangeRow
		after  *ChangeRow
	}
	groups := make(map[string]*updateGroup)
	seen := make(map[string]ChangeRow)
	singles := make([]Change, 0, len(sorted))

	for index := range sorted {
		row := sorted[index]
		key := row.Position().RowKey() + fmt.Sprintf("\x00%d\x00%s", row.Operation, row.UpdateMask)
		if previous, ok := seen[key]; ok {
			if !reflect.DeepEqual(previous.ClientValues(), row.ClientValues()) {
				return nil, fmt.Errorf("%w at %s", ErrConflictingChange, row.Position())
			}
			continue
		}
		seen[key] = row

		switch row.Operation {
		case OperationUpdateBefore, OperationUpdateAfter:
			key := row.Position().RowKey()
			group := groups[key]
			if group == nil {
				group = &updateGroup{}
				groups[key] = group
			}
			target := &group.before
			if row.Operation == OperationUpdateAfter {
				target = &group.after
			}
			if *target != nil {
				if !reflect.DeepEqual((*target).ClientValues(), row.ClientValues()) {
					return nil, fmt.Errorf("%w at %s", ErrConflictingChange, row.Position())
				}
				continue
			}
			copied := row
			*target = &copied

		case OperationInsert:
			singles = append(singles, Change{
				StartLSN:   row.StartLSN,
				SeqVal:     row.SeqVal,
				Kind:       KindInsert,
				Operation:  row.Operation,
				UpdateMask: append([]byte(nil), row.UpdateMask...),
				After:      cloneRow(row.ClientValues()),
			})

		case OperationDelete:
			singles = append(singles, Change{
				StartLSN:   row.StartLSN,
				SeqVal:     row.SeqVal,
				Kind:       KindDelete,
				Operation:  row.Operation,
				UpdateMask: append([]byte(nil), row.UpdateMask...),
				Before:     cloneRow(row.ClientValues()),
			})

		default:
			return nil, fmt.Errorf("%w: %d at %s", ErrUnknownOperation, int(row.Operation), row.Position())
		}
	}

	for _, group := range groups {
		effective := group.after
		if effective == nil {
			return nil, fmt.Errorf("%w at %s", ErrIncompleteUpdate, group.before.Position())
		}

		mask := append([]byte(nil), effective.UpdateMask...)
		if group.before != nil {
			mask = unionMasks(group.before.UpdateMask, effective.UpdateMask)
		}

		change := Change{
			StartLSN:       effective.StartLSN,
			SeqVal:         effective.SeqVal,
			Kind:           KindUpdate,
			Operation:      OperationUpdateAfter,
			UpdateMask:     mask,
			After:          cloneRow(effective.ClientValues()),
			ChangedColumns: MaskColumns(mask, columnOrder),
		}
		if group.before != nil {
			change.Before = cloneRow(group.before.ClientValues())
		}
		singles = append(singles, change)
	}

	sort.SliceStable(singles, func(i, j int) bool {
		return ComparePositions(singles[i].Position(), singles[j].Position()) < 0
	})
	return singles, nil
}

// PairUpdates is an alias for CombineChanges.
func PairUpdates(rows []ChangeRow) ([]Change, error) {
	return CombineChanges(rows)
}

// FilterChangesAfter removes changes that are at or before position. It is
// used when an LSN is re-read because the previous batch stopped inside that
// LSN.
func FilterChangesAfter(changes []Change, position Position) []Change {
	if position.IsZero() {
		return changes
	}
	out := make([]Change, 0, len(changes))
	for _, change := range changes {
		if ComparePositions(change.Position(), position) > 0 {
			out = append(out, change)
		}
	}
	return out
}

// MaskBit reports whether the SQL Server __$update_mask bit for a 1-based
// column ordinal is set. SQL Server numbers bits from the least-significant
// bit of the first mask byte.
func MaskBit(mask []byte, ordinal int) bool {
	if ordinal < 1 {
		return false
	}
	index := (ordinal - 1) / 8
	if index >= len(mask) {
		return false
	}
	return mask[index]&(1<<uint((ordinal-1)%8)) != 0
}

// MaskColumns returns the names selected by an update mask. columnOrder is
// the capture instance's captured-column order, starting at ordinal 1.
func MaskColumns(mask []byte, columnOrder []string) []string {
	if len(mask) == 0 || len(columnOrder) == 0 {
		return nil
	}
	columns := make([]string, 0, len(columnOrder))
	for index, name := range columnOrder {
		if MaskBit(mask, index+1) {
			columns = append(columns, name)
		}
	}
	return columns
}

// MergeChanged overlays changed columns from after onto before.
func MergeChanged(before, after map[string]any, changed []string) map[string]any {
	merged := cloneRow(before)
	if merged == nil {
		merged = make(map[string]any, len(after))
	}
	for _, column := range changed {
		value, ok := after[column]
		if !ok {
			delete(merged, column)
			continue
		}
		merged[column] = value
	}
	return merged
}

// MergeMasked merges an update after-image onto a before-image using the
// update mask. When columnOrder is nil, every key in after is applied.
func MergeMasked(before, after map[string]any, mask []byte, columnOrder []string) map[string]any {
	merged := cloneRow(before)
	if merged == nil {
		merged = make(map[string]any, len(after))
	}
	if len(mask) == 0 || len(columnOrder) == 0 {
		for column, value := range after {
			merged[column] = value
		}
		return merged
	}
	for index, column := range columnOrder {
		if !MaskBit(mask, index+1) {
			continue
		}
		value, ok := after[column]
		if !ok {
			delete(merged, column)
			continue
		}
		merged[column] = value
	}
	return merged
}

// Apply returns the row that results from applying the change to before.
// Insert ignores before, delete returns nil, and update merges the changed
// columns from the after image.
func (c Change) Apply(before map[string]any) map[string]any {
	switch c.Kind {
	case KindInsert:
		return cloneRow(c.After)
	case KindDelete:
		return nil
	case KindUpdate:
		if len(c.ChangedColumns) > 0 {
			return MergeChanged(before, c.After, c.ChangedColumns)
		}
		return MergeMasked(before, c.After, c.UpdateMask, nil)
	default:
		return cloneRow(before)
	}
}

func unionMasks(a, b []byte) []byte {
	width := len(a)
	if len(b) > width {
		width = len(b)
	}
	out := make([]byte, width)
	for i := 0; i < width; i++ {
		if i < len(a) {
			out[i] |= a[i]
		}
		if i < len(b) {
			out[i] |= b[i]
		}
	}
	return out
}

func cloneRow(row map[string]any) map[string]any {
	if row == nil {
		return nil
	}
	out := make(map[string]any, len(row))
	for key, value := range row {
		out[key] = value
	}
	return out
}
