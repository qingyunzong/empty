package dataeng

import (
	"fmt"
	"sort"
)

// ReferenceRow is a materialized row used by the row-by-row delete reference.
// FilePath and Position identify the row in its data file, matching the
// coordinates stored in position delete files.
type ReferenceRow struct {
	Values             map[string]any
	FilePath           string
	Position           int64
	DataSequenceNumber int64
	SpecID             int
	Partition          Partition
}

// ReferencePositionDelete is one record from a position delete file.
type ReferencePositionDelete struct {
	FilePath           string
	Position           int64
	DataSequenceNumber int64
}

// ReferenceEqualityDelete is one record from an equality delete file.  An empty
// Partition means the delete is global (as with an unpartitioned equality
// delete file).
type ReferenceEqualityDelete struct {
	Values             map[string]any
	EqualityFieldIDs   []int
	DataSequenceNumber int64
	SpecID             int
	Partition          Partition
}

// ReferenceTable is a small in-memory table used as the oracle for scan
// planning.  Callers should populate deletes from the same snapshot being
// planned; the reference does not know about snapshot lineage.
type ReferenceTable struct {
	Rows            []ReferenceRow
	PositionDeletes []ReferencePositionDelete
	EqualityDeletes []ReferenceEqualityDelete
}

// PositionDeleteMatchesRow applies the position-delete sequence rule row by row:
// a delete applies when the row's data sequence is less than or equal to the
// delete's sequence.
func PositionDeleteMatchesRow(row ReferenceRow, delete ReferencePositionDelete) bool {
	return delete.FilePath == row.FilePath &&
		delete.Position == row.Position &&
		row.DataSequenceNumber <= delete.DataSequenceNumber
}

// EqualityDeleteMatchesRow applies the equality-delete sequence rule row by
// row: equality deletes apply only to strictly older data.
func EqualityDeleteMatchesRow(row ReferenceRow, delete ReferenceEqualityDelete) bool {
	if row.DataSequenceNumber >= delete.DataSequenceNumber {
		return false
	}
	if !referencePartitionMatches(row, delete) {
		return false
	}
	for name, want := range delete.Values {
		got, ok := row.Values[name]
		if !ok {
			return false
		}
		if !valuesEqual(got, want) {
			return false
		}
	}
	return true
}

func referencePartitionMatches(row ReferenceRow, delete ReferenceEqualityDelete) bool {
	if len(delete.Partition) == 0 {
		return true
	}
	if delete.SpecID != 0 && row.SpecID != 0 && delete.SpecID != row.SpecID {
		// Different layouts cannot be compared without the specs.  The
		// conservative row-level answer is "may match".
		return true
	}
	for name, want := range delete.Partition {
		if !valuesEqual(row.Partition[name], want) {
			return false
		}
	}
	return true
}

// ApplyReferenceDeletes materializes rows and removes every row matched by a
// position or equality delete.  It is intentionally a straightforward nested
// loop: small tables are the reference implementation, not the fast path.
func ApplyReferenceDeletes(rows []ReferenceRow, positionDeletes []ReferencePositionDelete, equalityDeletes []ReferenceEqualityDelete) []ReferenceRow {
	out := make([]ReferenceRow, 0, len(rows))
	for _, row := range rows {
		deleted := false
		for _, delete := range positionDeletes {
			if PositionDeleteMatchesRow(row, delete) {
				deleted = true
				break
			}
		}
		if !deleted {
			for _, delete := range equalityDeletes {
				if EqualityDeleteMatchesRow(row, delete) {
					deleted = true
					break
				}
			}
		}
		if !deleted {
			out = append(out, row)
		}
	}
	sortReferenceRows(out)
	return out
}

// ApplyDeletes is a short alias for ApplyReferenceDeletes.
func ApplyDeletes(rows []ReferenceRow, positionDeletes []ReferencePositionDelete, equalityDeletes []ReferenceEqualityDelete) []ReferenceRow {
	return ApplyReferenceDeletes(rows, positionDeletes, equalityDeletes)
}

// Materialize applies all deletes in the reference table.
func (r *ReferenceTable) Materialize() []ReferenceRow {
	if r == nil {
		return nil
	}
	return ApplyReferenceDeletes(r.Rows, r.PositionDeletes, r.EqualityDeletes)
}

// DeleteRecordReader reads the logical records of delete files.  Scan planning
// only needs file metadata; the reference engine needs the rows to verify the
// plan.
type DeleteRecordReader interface {
	ReadPositionDeletes(file *DataFile) ([]ReferencePositionDelete, error)
	ReadEqualityDeletes(file *DataFile) ([]ReferenceEqualityDelete, error)
}

// DeleteRecordReaderFunc is a pair of functions implementing DeleteRecordReader.
type DeleteRecordReaderFunc struct {
	Position func(file *DataFile) ([]ReferencePositionDelete, error)
	Equality func(file *DataFile) ([]ReferenceEqualityDelete, error)
}

// ReadPositionDeletes implements DeleteRecordReader.
func (f DeleteRecordReaderFunc) ReadPositionDeletes(file *DataFile) ([]ReferencePositionDelete, error) {
	if f.Position == nil {
		return nil, nil
	}
	return f.Position(file)
}

// ReadEqualityDeletes implements DeleteRecordReader.
func (f DeleteRecordReaderFunc) ReadEqualityDeletes(file *DataFile) ([]ReferenceEqualityDelete, error) {
	if f.Equality == nil {
		return nil, nil
	}
	return f.Equality(file)
}

// MaterializePlan applies only the delete files attached to the plan's tasks.
// Rows from data files that were pruned out are not returned.
func MaterializePlan(plan *ScanPlan, rows []ReferenceRow, reader DeleteRecordReader) ([]ReferenceRow, error) {
	if plan == nil {
		return nil, fmt.Errorf("%w: nil plan", ErrInvalidManifest)
	}
	if reader == nil {
		return nil, fmt.Errorf("%w: nil delete record reader", ErrManifestLoaderRequired)
	}

	rowsByPath := make(map[string][]ReferenceRow)
	for _, row := range rows {
		rowsByPath[row.FilePath] = append(rowsByPath[row.FilePath], row)
	}

	out := make([]ReferenceRow, 0, len(rows))
	for _, task := range plan.Tasks {
		taskRows := rowsByPath[task.DataFile.FilePath]
		if len(taskRows) == 0 {
			continue
		}
		var positionDeletes []ReferencePositionDelete
		var equalityDeletes []ReferenceEqualityDelete
		for _, delete := range task.DeleteFiles {
			switch delete.Content() {
			case FileContentPositionDeletes, FileContentDeletionVector:
				records, err := reader.ReadPositionDeletes(delete.DataFile)
				if err != nil {
					return nil, err
				}
				positionDeletes = append(positionDeletes, records...)
			case FileContentEqualityDeletes:
				records, err := reader.ReadEqualityDeletes(delete.DataFile)
				if err != nil {
					return nil, err
				}
				equalityDeletes = append(equalityDeletes, records...)
			}
		}
		out = append(out, ApplyReferenceDeletes(taskRows, positionDeletes, equalityDeletes)...)
	}
	sortReferenceRows(out)
	return out, nil
}

// VerifyPlan compares the rows produced from the planner's delete bindings with
// the row-by-row reference.  It is meant for small-table tests and diagnostics.
func VerifyPlan(plan *ScanPlan, rows []ReferenceRow, reader DeleteRecordReader) error {
	if plan == nil {
		return fmt.Errorf("%w: nil plan", ErrInvalidManifest)
	}
	if reader == nil {
		return fmt.Errorf("%w: nil delete record reader", ErrManifestLoaderRequired)
	}
	if err := plan.Validate(); err != nil {
		return err
	}

	var positionDeletes []ReferencePositionDelete
	var equalityDeletes []ReferenceEqualityDelete
	for _, delete := range plan.DeleteFiles {
		switch delete.Content() {
		case FileContentPositionDeletes, FileContentDeletionVector:
			records, err := reader.ReadPositionDeletes(delete.DataFile)
			if err != nil {
				return err
			}
			positionDeletes = append(positionDeletes, records...)
		case FileContentEqualityDeletes:
			records, err := reader.ReadEqualityDeletes(delete.DataFile)
			if err != nil {
				return err
			}
			equalityDeletes = append(equalityDeletes, records...)
		}
	}

	selected := make(map[string]struct{}, len(plan.Tasks))
	for _, task := range plan.Tasks {
		selected[task.DataFile.FilePath] = struct{}{}
	}
	selectedRows := make([]ReferenceRow, 0, len(rows))
	for _, row := range rows {
		if _, ok := selected[row.FilePath]; ok {
			selectedRows = append(selectedRows, row)
		}
	}

	expected := ApplyReferenceDeletes(selectedRows, positionDeletes, equalityDeletes)
	actual, err := MaterializePlan(plan, rows, reader)
	if err != nil {
		return err
	}
	if !sameRows(expected, actual) {
		return fmt.Errorf("dataeng: plan output differs from row-by-row reference: expected %d rows, got %d",
			len(expected), len(actual))
	}
	return nil
}

func sortReferenceRows(rows []ReferenceRow) {
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].FilePath != rows[j].FilePath {
			return rows[i].FilePath < rows[j].FilePath
		}
		return rows[i].Position < rows[j].Position
	})
}

func sameRows(a, b []ReferenceRow) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].FilePath != b[i].FilePath || a[i].Position != b[i].Position {
			return false
		}
	}
	return true
}
