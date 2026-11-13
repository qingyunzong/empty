package dataeng

import (
	"fmt"
	"math"
	"sort"
)

// PlanOption configures planner output.
type PlanOption func(*planConfig)

type planConfig struct {
	includeEmptyFiles bool
}

func newPlanConfig(options ...PlanOption) planConfig {
	var config planConfig
	for _, option := range options {
		if option != nil {
			option(&config)
		}
	}
	return config
}

// WithEmptyDataFiles includes every scanned data file in the plan, even when
// no visible delete record applies. By default only files with at least one
// deleted row are emitted.
func WithEmptyDataFiles() PlanOption {
	return func(config *planConfig) {
		config.includeEmptyFiles = true
	}
}

// WithAllDataFiles is an alias for WithEmptyDataFiles.
func WithAllDataFiles() PlanOption {
	return WithEmptyDataFiles()
}

// FilePlan is the ordered delete plan for one data file.
//
// Intervals are sorted and non-overlapping half-open ranges. DeleteFiles names
// the delete files that contributed at least one applicable record; entries are
// unique and sorted by canonical path.
type FilePlan struct {
	Path           string
	SequenceNumber int64
	RowCount       int64
	Intervals      []Interval
	DeleteFiles    []string
}

// DeletedCount returns the number of distinct positions covered by the plan.
func (f FilePlan) DeletedCount() int64 {
	var total int64
	for _, interval := range f.Intervals {
		total += interval.Len()
	}
	return total
}

// IsDeleted reports whether a zero-based row position is covered.
func (f FilePlan) IsDeleted(position int64) bool {
	return covers(f.Intervals, position)
}

// Plan is a deterministic, file-grouped position delete plan.
//
// SnapshotID is the target snapshot, or zero for PlanDeletes which plans a
// caller-supplied visible delete set without catalog lineage.
type Plan struct {
	SnapshotID int64
	Files      []FilePlan
}

// File returns the group for a path. If multiple input data files share the
// canonical path, the first group is returned.
func (p Plan) File(path string) (FilePlan, bool) {
	key := CanonicalPath(path)
	for _, file := range p.Files {
		if CanonicalPath(file.Path) == key {
			return file, true
		}
	}
	return FilePlan{}, false
}

// FileFor returns the group for a canonical path and data sequence number.
func (p Plan) FileFor(path string, sequenceNumber int64) (FilePlan, bool) {
	return p.filePlan(path, sequenceNumber)
}

// IsDeleted reports whether a position is deleted for a data file path.
func (p Plan) IsDeleted(path string, position int64) bool {
	file, ok := p.File(path)
	return ok && file.IsDeleted(position)
}

// IsDeletedFor reports whether a position is deleted for a specific data file
// version. Prefer this over IsDeleted when data files can share a path but
// differ in sequence number.
func (p Plan) IsDeletedFor(path string, sequenceNumber int64, position int64) bool {
	file, ok := p.filePlan(path, sequenceNumber)
	return ok && file.IsDeleted(position)
}

// DeletedCount returns the number of distinct deleted positions across all
// data files.
func (p Plan) DeletedCount() int64 {
	var total int64
	for _, file := range p.Files {
		total += file.DeletedCount()
	}
	return total
}

// PlanDeletes plans position deletes for an already-resolved visible delete
// set. It applies only path and sequence-number rules; callers that need
// snapshot lineage should use Catalog.PlanSnapshot or Catalog.PlanBranch.
//
// Delete records that name data files outside dataFiles are ignored, which lets
// a reader plan a projected subset of a table without failing on unrelated
// delete records.
//
// The returned Plan has SnapshotID zero.
func PlanDeletes(dataFiles []DataFile, deleteFiles []DeleteFile, options ...PlanOption) (Plan, error) {
	return planVisible(0, dataFiles, deleteFiles, newPlanConfig(options...))
}

// Planner binds a Catalog and planner options.
type Planner struct {
	catalog *Catalog
	config  planConfig
}

// NewPlanner creates a planner for a catalog.
func NewPlanner(catalog *Catalog, options ...PlanOption) *Planner {
	return &Planner{catalog: catalog, config: newPlanConfig(options...)}
}

// PlanSnapshot plans deletes visible at snapshotID.
func (p *Planner) PlanSnapshot(snapshotID int64, dataFiles []DataFile) (Plan, error) {
	if p == nil || p.catalog == nil {
		return Plan{}, fmt.Errorf("dataeng: planner has no catalog")
	}
	deleteFiles, err := p.catalog.VisibleDeleteFiles(snapshotID)
	if err != nil {
		return Plan{}, err
	}
	return planVisible(snapshotID, dataFiles, deleteFiles, p.config)
}

// PlanBranch plans deletes visible at a branch head.
func (p *Planner) PlanBranch(branch string, dataFiles []DataFile) (Plan, error) {
	if p == nil || p.catalog == nil {
		return Plan{}, fmt.Errorf("dataeng: planner has no catalog")
	}
	id, err := p.catalog.ResolveBranch(branch)
	if err != nil {
		return Plan{}, err
	}
	return p.PlanSnapshot(id, dataFiles)
}

type indexedDelete struct {
	position  int64
	sequence  int64
	source    string
	sourceKey string
}

func planVisible(snapshotID int64, dataFiles []DataFile, deleteFiles []DeleteFile, config planConfig) (Plan, error) {
	deleteIndex := make(map[string][]indexedDelete)
	for _, file := range deleteFiles {
		if file.SequenceNumber < 0 {
			return Plan{}, fmt.Errorf("dataeng: delete file %q has negative sequence number %d", file.Path, file.SequenceNumber)
		}
		sourceKey := CanonicalPath(file.Path)
		for _, record := range file.Records {
			if record.FilePath == "" {
				return Plan{}, fmt.Errorf("dataeng: delete file %q contains a record with an empty data file path", file.Path)
			}
			if record.Position < 0 {
				return Plan{}, fmt.Errorf("dataeng: delete file %q contains negative position %d for %q",
					file.Path, record.Position, record.FilePath)
			}
			if record.Position == math.MaxInt64 {
				return Plan{}, fmt.Errorf("dataeng: delete file %q contains position %d for %q, which cannot be represented as a half-open interval",
					file.Path, record.Position, record.FilePath)
			}
			key := CanonicalPath(record.FilePath)
			deleteIndex[key] = append(deleteIndex[key], indexedDelete{
				position:  record.Position,
				sequence:  file.SequenceNumber,
				source:    file.Path,
				sourceKey: sourceKey,
			})
		}
	}

	type dataEntry struct {
		file DataFile
		key  string
	}
	entries := make([]dataEntry, 0, len(dataFiles))
	seen := make(map[string]struct{}, len(dataFiles))
	for _, file := range dataFiles {
		if file.Path == "" {
			return Plan{}, fmt.Errorf("dataeng: data file path must not be empty")
		}
		if file.SequenceNumber < 0 {
			return Plan{}, fmt.Errorf("dataeng: data file %q has negative sequence number %d", file.Path, file.SequenceNumber)
		}
		key := CanonicalPath(file.Path)
		identity := key + "\x00" + fmt.Sprint(file.SequenceNumber)
		if _, exists := seen[identity]; exists {
			continue
		}
		seen[identity] = struct{}{}
		entries = append(entries, dataEntry{file: file, key: key})
	}

	files := make([]FilePlan, 0, len(entries))
	for _, entry := range entries {
		var positions []int64
		sources := make(map[string]string)
		for _, deletion := range deleteIndex[entry.key] {
			// A delete file must never affect data that is newer than itself.
			if deletion.sequence < entry.file.SequenceNumber {
				continue
			}
			positions = append(positions, deletion.position)
			if deletion.source != "" {
				sources[deletion.sourceKey] = deletion.source
			}
		}
		if len(positions) == 0 && !config.includeEmptyFiles {
			continue
		}

		sourceKeys := make([]string, 0, len(sources))
		for key := range sources {
			sourceKeys = append(sourceKeys, key)
		}
		sort.Strings(sourceKeys)
		sourcePaths := make([]string, 0, len(sourceKeys))
		for _, key := range sourceKeys {
			sourcePaths = append(sourcePaths, sources[key])
		}

		files = append(files, FilePlan{
			Path:           entry.file.Path,
			SequenceNumber: entry.file.SequenceNumber,
			RowCount:       entry.file.RowCount,
			Intervals:      coalescePositions(positions),
			DeleteFiles:    sourcePaths,
		})
	}

	sort.SliceStable(files, func(i, j int) bool {
		ki, kj := CanonicalPath(files[i].Path), CanonicalPath(files[j].Path)
		if ki != kj {
			return ki < kj
		}
		if files[i].Path != files[j].Path {
			return files[i].Path < files[j].Path
		}
		return files[i].SequenceNumber < files[j].SequenceNumber
	})
	return Plan{SnapshotID: snapshotID, Files: files}, nil
}
