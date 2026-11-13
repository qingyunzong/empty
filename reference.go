package dataeng

import (
	"fmt"
	"slices"
)

// Row is one data row. The values are opaque to this package; they are only
// compared by verification.
type Row []string

// FileRows pairs a data file with the rows read from it.
type FileRows struct {
	DataFile DataFile
	Rows     []Row
}

// VisibleFile is the visible row set for one input data file.
type VisibleFile struct {
	Path           string
	SequenceNumber int64
	Rows           []Row
}

// VisibleResult contains visible rows in the same order as the input files.
type VisibleResult struct {
	Files []VisibleFile
}

// ReferenceVisible applies position deletes row by row.
//
// This is the deliberately simple reference implementation: for every data row
// it scans every applicable delete record and removes the row when a record has
// the same canonical data file path, the exact position, and a delete sequence
// number greater than or equal to the data file's sequence number. It does not
// build intervals. Callers should pass the same visible delete set that was
// planned (for example Catalog.VisibleDeleteFiles).
func ReferenceVisible(files []FileRows, deleteFiles []DeleteFile) (VisibleResult, error) {
	type applicableDelete struct {
		pathKey  string
		position int64
		sequence int64
	}
	deletes := make([]applicableDelete, 0)
	for _, file := range deleteFiles {
		if file.SequenceNumber < 0 {
			return VisibleResult{}, fmt.Errorf("dataeng: delete file %q has negative sequence number %d", file.Path, file.SequenceNumber)
		}
		for _, record := range file.Records {
			if record.FilePath == "" {
				return VisibleResult{}, fmt.Errorf("dataeng: delete file %q contains a record with an empty data file path", file.Path)
			}
			if record.Position < 0 {
				return VisibleResult{}, fmt.Errorf("dataeng: delete file %q contains negative position %d for %q",
					file.Path, record.Position, record.FilePath)
			}
			deletes = append(deletes, applicableDelete{
				pathKey:  CanonicalPath(record.FilePath),
				position: record.Position,
				sequence: file.SequenceNumber,
			})
		}
	}

	result := VisibleResult{Files: make([]VisibleFile, 0, len(files))}
	for _, file := range files {
		if file.DataFile.Path == "" {
			return VisibleResult{}, fmt.Errorf("dataeng: data file path must not be empty")
		}
		if file.DataFile.SequenceNumber < 0 {
			return VisibleResult{}, fmt.Errorf("dataeng: data file %q has negative sequence number %d",
				file.DataFile.Path, file.DataFile.SequenceNumber)
		}
		key := CanonicalPath(file.DataFile.Path)
		visible := make([]Row, 0, len(file.Rows))
		for position, row := range file.Rows {
			deleted := false
			for _, deletion := range deletes {
				if deletion.pathKey != key {
					continue
				}
				if deletion.sequence < file.DataFile.SequenceNumber {
					continue
				}
				if deletion.position == int64(position) {
					deleted = true
					break
				}
			}
			if !deleted {
				visible = append(visible, row)
			}
		}
		result.Files = append(result.Files, VisibleFile{
			Path:           file.DataFile.Path,
			SequenceNumber: file.DataFile.SequenceNumber,
			Rows:           visible,
		})
	}
	return result, nil
}

// VisibleRows applies this interval plan to concrete rows.
//
// Files without a plan group are fully visible. Rows beyond a planned interval
// are irrelevant; an interval that extends past the available rows simply
// covers no additional rows.
func (p Plan) VisibleRows(files []FileRows) (VisibleResult, error) {
	result := VisibleResult{Files: make([]VisibleFile, 0, len(files))}
	for _, file := range files {
		if file.DataFile.Path == "" {
			return VisibleResult{}, fmt.Errorf("dataeng: data file path must not be empty")
		}
		if file.DataFile.SequenceNumber < 0 {
			return VisibleResult{}, fmt.Errorf("dataeng: data file %q has negative sequence number %d",
				file.DataFile.Path, file.DataFile.SequenceNumber)
		}
		plan, planned := p.filePlan(file.DataFile.Path, file.DataFile.SequenceNumber)
		visible := make([]Row, 0, len(file.Rows))
		for position, row := range file.Rows {
			if planned && plan.IsDeleted(int64(position)) {
				continue
			}
			visible = append(visible, row)
		}
		result.Files = append(result.Files, VisibleFile{
			Path:           file.DataFile.Path,
			SequenceNumber: file.DataFile.SequenceNumber,
			Rows:           visible,
		})
	}
	return result, nil
}

func (p Plan) filePlan(path string, sequence int64) (FilePlan, bool) {
	key := CanonicalPath(path)
	for i := range p.Files {
		file := &p.Files[i]
		if CanonicalPath(file.Path) != key {
			continue
		}
		if file.SequenceNumber == sequence {
			return *file, true
		}
	}
	return FilePlan{}, false
}

// VerifyPlan checks that applying an interval plan yields exactly the visible
// records produced by the row-by-row reference implementation.
func VerifyPlan(plan Plan, files []FileRows, deleteFiles []DeleteFile) error {
	reference, err := ReferenceVisible(files, deleteFiles)
	if err != nil {
		return err
	}
	planned, err := plan.VisibleRows(files)
	if err != nil {
		return err
	}
	if len(reference.Files) != len(planned.Files) {
		return fmt.Errorf("dataeng: visible file count mismatch: reference %d, plan %d",
			len(reference.Files), len(planned.Files))
	}
	for i := range reference.Files {
		want, got := reference.Files[i], planned.Files[i]
		if !PathsEqual(want.Path, got.Path) || want.SequenceNumber != got.SequenceNumber {
			return fmt.Errorf("dataeng: visible file %d mismatch: reference %q@%d, plan %q@%d",
				i, want.Path, want.SequenceNumber, got.Path, got.SequenceNumber)
		}
		if len(want.Rows) != len(got.Rows) {
			return fmt.Errorf("dataeng: visible row count mismatch for %q: reference %d, plan %d",
				want.Path, len(want.Rows), len(got.Rows))
		}
		for row := range want.Rows {
			if !slices.Equal(want.Rows[row], got.Rows[row]) {
				return fmt.Errorf("dataeng: visible row %d mismatch for %q: reference %v, plan %v",
					row, want.Path, want.Rows[row], got.Rows[row])
			}
		}
	}
	return nil
}

// Verify is a method-form convenience for VerifyPlan.
func (p Plan) Verify(files []FileRows, deleteFiles []DeleteFile) error {
	return VerifyPlan(p, files, deleteFiles)
}

// ReferenceVisibleAt resolves snapshot visibility and runs the row-by-row
// reference implementation.
func (c *Catalog) ReferenceVisibleAt(snapshotID int64, files []FileRows) (VisibleResult, error) {
	deleteFiles, err := c.VisibleDeleteFiles(snapshotID)
	if err != nil {
		return VisibleResult{}, err
	}
	return ReferenceVisible(files, deleteFiles)
}

// VerifySnapshotPlan resolves snapshot visibility and verifies a plan against
// the row-by-row reference implementation.
func (c *Catalog) VerifySnapshotPlan(snapshotID int64, plan Plan, files []FileRows) error {
	deleteFiles, err := c.VisibleDeleteFiles(snapshotID)
	if err != nil {
		return err
	}
	return VerifyPlan(plan, files, deleteFiles)
}
