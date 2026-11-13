package dataeng

import (
	"fmt"
	"sort"
)

// ManifestLoader loads the entries of one manifest.  Implementations normally
// read Avro from object storage; tests and planners may embed Entries instead.
type ManifestLoader interface {
	LoadManifest(manifest ManifestFile) ([]ManifestEntry, error)
}

// ManifestLoaderFunc adapts a function to ManifestLoader.
type ManifestLoaderFunc func(manifest ManifestFile) ([]ManifestEntry, error)

// LoadManifest implements ManifestLoader.
func (f ManifestLoaderFunc) LoadManifest(manifest ManifestFile) ([]ManifestEntry, error) {
	if f == nil {
		return nil, ErrManifestLoaderRequired
	}
	return f(manifest)
}

// ManifestListLoader loads the manifest list for a snapshot.  It is only used
// when Snapshot.Manifests is empty and Snapshot.ManifestList names a list.
type ManifestListLoader interface {
	LoadManifestList(snapshot Snapshot) ([]ManifestFile, error)
}

// ManifestListLoaderFunc adapts a function to ManifestListLoader.
type ManifestListLoaderFunc func(snapshot Snapshot) ([]ManifestFile, error)

// LoadManifestList implements ManifestListLoader.
func (f ManifestListLoaderFunc) LoadManifestList(snapshot Snapshot) ([]ManifestFile, error) {
	if f == nil {
		return nil, ErrManifestLoaderRequired
	}
	return f(snapshot)
}

// Planner builds scan plans for a table.
type Planner struct {
	Table      *Table
	Loader     ManifestLoader
	ListLoader ManifestListLoader
	SnapshotID int64
}

// ScanPlanner and ScanTask are aliases matching common planner terminology.
type ScanPlanner = Planner
type ScanTask = FileScanTask

// NewPlanner constructs a planner.  Arguments may include a *Table, a snapshot
// id, a ManifestLoader, or a ManifestListLoader; this keeps the constructor
// convenient for both production catalogs and table-driven tests.
func NewPlanner(args ...any) *Planner {
	p := &Planner{Table: NewTable()}
	for _, arg := range args {
		switch v := arg.(type) {
		case *Table:
			if v != nil {
				p.Table = v
			}
		case Table:
			copy := v
			p.Table = &copy
		case int:
			p.SnapshotID = int64(v)
		case int64:
			p.SnapshotID = v
		case ManifestLoader:
			p.Loader = v
		case ManifestLoaderFunc:
			p.Loader = v
		case ManifestListLoader:
			p.ListLoader = v
		case ManifestListLoaderFunc:
			p.ListLoader = v
		}
	}
	if p.Table == nil {
		p.Table = NewTable()
	}
	return p
}

// NewPlannerForSnapshot constructs a planner defaulted to one snapshot.
func NewPlannerForSnapshot(table *Table, snapshotID int64) *Planner {
	return NewPlanner(table, snapshotID)
}

// NewScanPlanner is an alias of NewPlanner.
func NewScanPlanner(args ...any) *Planner {
	return NewPlanner(args...)
}

// SetTable replaces the planner's table.
func (p *Planner) SetTable(table *Table) *Planner {
	p.Table = table
	return p
}

// SetManifestLoader installs a manifest entry loader.
func (p *Planner) SetManifestLoader(loader ManifestLoader) *Planner {
	p.Loader = loader
	return p
}

// SetManifestListLoader installs a manifest list loader.
func (p *Planner) SetManifestListLoader(loader ManifestListLoader) *Planner {
	p.ListLoader = loader
	return p
}

// FileScanTask is one data file and the delete files that must be applied to it.
type FileScanTask struct {
	DataFile           *DataFile
	DataSequenceNumber int64
	FileSequenceNumber int64
	SpecID             int

	PositionDeletes     []*BoundDeleteFile
	EqualityDeletes     []*BoundDeleteFile
	DeletionVectors     []*BoundDeleteFile
	DeleteFiles         []*BoundDeleteFile
	PositionDeleteFiles []*BoundDeleteFile
	EqualityDeleteFiles []*BoundDeleteFile
}

// HasDeletes reports whether the task has any delete file.
func (t *FileScanTask) HasDeletes() bool {
	return t != nil && len(t.DeleteFiles) != 0
}

// DeleteFilePaths returns the paths of all delete files attached to the task.
func (t *FileScanTask) DeleteFilePaths() []string {
	if t == nil {
		return nil
	}
	out := make([]string, 0, len(t.DeleteFiles))
	for _, delete := range t.DeleteFiles {
		out = append(out, delete.Path())
	}
	return out
}

// ScanStats summarizes what planning considered.
type ScanStats struct {
	Manifests             int
	DataManifests         int
	DeleteManifests       int
	DataFiles             int
	PrunedDataFiles       int
	DeleteFiles           int
	BoundDeleteFiles      int
	IgnoredFutureEntries  int
	IgnoredDeletedEntries int
	DeduplicatedEntries   int
}

// ScanPlan is the result of planning a snapshot scan.
type ScanPlan struct {
	SnapshotID     int64
	SequenceNumber int64

	Tasks []*FileScanTask
	Files []*FileScanTask

	// DataFiles is the selected data-file set after partition pruning.
	DataFiles []*BoundFile
	// DeleteFiles is every live delete file in the snapshot.  It is not filtered
	// by the query's partition predicate: a delete may have been written under
	// an unpartitioned or older spec and can still match a selected data file.
	DeleteFiles []*BoundDeleteFile
	// BoundDeleteFiles is the union of deletes attached to at least one task.
	BoundDeleteFiles []*BoundDeleteFile
	// UnboundDeleteFiles contains live deletes that do not apply to any selected
	// data file.  They remain visible for diagnostics rather than being pruned.
	UnboundDeleteFiles []*BoundDeleteFile

	Stats ScanStats
}

// AllDeleteFiles returns the union of delete files attached to tasks.
func (p *ScanPlan) AllDeleteFiles() []*BoundDeleteFile {
	return p.BoundDeleteFiles
}

// DataFilePaths returns the selected data file paths in task order.
func (p *ScanPlan) DataFilePaths() []string {
	if p == nil {
		return nil
	}
	out := make([]string, 0, len(p.Tasks))
	for _, task := range p.Tasks {
		out = append(out, task.DataFile.FilePath)
	}
	return out
}

// DeleteFilePaths returns every live delete file path in the plan.
func (p *ScanPlan) DeleteFilePaths() []string {
	if p == nil {
		return nil
	}
	out := make([]string, 0, len(p.DeleteFiles))
	for _, delete := range p.DeleteFiles {
		out = append(out, delete.Path())
	}
	return out
}

// Validate checks the core invariants of a plan.  It is useful for callers that
// build plans from remote metadata and for tests.
func (p *ScanPlan) Validate() error {
	if p == nil {
		return fmt.Errorf("%w: nil plan", ErrInvalidManifest)
	}
	for _, task := range p.Tasks {
		if task == nil || task.DataFile == nil {
			return fmt.Errorf("%w: task without data file", ErrInvalidManifest)
		}
		if task.DataSequenceNumber > p.SequenceNumber {
			return fmt.Errorf("%w: data file %s is newer than snapshot %d",
				ErrInvalidSequenceNumber, task.DataFile.FilePath, p.SequenceNumber)
		}
		for _, del := range task.DeleteFiles {
			if del == nil || del.DataFile == nil {
				return fmt.Errorf("%w: nil delete file in task %s",
					ErrInvalidManifest, task.DataFile.FilePath)
			}
			if del.DataSequenceNumber > p.SequenceNumber {
				return fmt.Errorf("%w: delete file %s is newer than snapshot %d",
					ErrInvalidSequenceNumber, del.DataFile.FilePath, p.SequenceNumber)
			}
			if !DeleteApplies(task.DataSequenceNumber, del.DataSequenceNumber, del.Content()) {
				return fmt.Errorf("%w: delete %s (seq %d) cannot apply to %s (seq %d)",
					ErrInvalidManifest, del.DataFile.FilePath, del.DataSequenceNumber,
					task.DataFile.FilePath, task.DataSequenceNumber)
			}
		}
	}
	return nil
}

// ScanOptions configures PlanWithOptions.
type ScanOptions struct {
	SnapshotID int64
	Predicate  any
	Filter     any
	Loader     ManifestLoader
	ListLoader ManifestListLoader
}

// PlanWithOptions plans a scan using explicit options.
func (p *Planner) PlanWithOptions(options ScanOptions) (*ScanPlan, error) {
	filter := options.Predicate
	if filter == nil {
		filter = options.Filter
	}
	return p.plan(options.SnapshotID, filter, options.Loader, options.ListLoader)
}

// Plan plans a scan of snapshotID.  A zero snapshot id means the table's
// current snapshot.  filter may be nil, a Predicate, PredicateFunc, a
// func(Partition) bool, a func(*PartitionSpec, Partition) bool, or a
// map[string]any of partition-field equalities.
func (p *Planner) Plan(snapshotID int64, filter any) (*ScanPlan, error) {
	return p.plan(snapshotID, filter, p.Loader, p.ListLoader)
}

// PlanCurrent plans the table's current snapshot.
func (p *Planner) PlanCurrent(filter any) (*ScanPlan, error) {
	return p.plan(p.SnapshotID, filter, p.Loader, p.ListLoader)
}

// PlanFiles returns only the file scan tasks.
func (p *Planner) PlanFiles(snapshotID int64, filter any) ([]*FileScanTask, error) {
	plan, err := p.Plan(snapshotID, filter)
	if err != nil {
		return nil, err
	}
	return plan.Tasks, nil
}

func (p *Planner) plan(snapshotID int64, filter any, loader ManifestLoader, listLoader ManifestListLoader) (*ScanPlan, error) {
	if p == nil || p.Table == nil {
		return nil, fmt.Errorf("%w: nil table", ErrSnapshotNotFound)
	}
	if snapshotID == 0 {
		snapshotID = p.SnapshotID
	}
	var snapshot *Snapshot
	if snapshotID == 0 {
		var ok bool
		snapshot, ok = p.Table.Current()
		if !ok {
			return nil, ErrNoCurrentSnapshot
		}
	} else {
		var ok bool
		snapshot, ok = p.Table.Snapshot(snapshotID)
		if !ok {
			return nil, fmt.Errorf("%w: %d", ErrSnapshotNotFound, snapshotID)
		}
	}

	manifests, err := p.loadLiveManifests(*snapshot, loader, listLoader)
	if err != nil {
		return nil, err
	}
	merged, err := MergeManifests(manifests, snapshot.SequenceNumber)
	if err != nil {
		return nil, err
	}

	predicate := NormalizePredicate(filter)
	plan := &ScanPlan{
		SnapshotID:     snapshot.SnapshotID,
		SequenceNumber: snapshot.SequenceNumber,
		Stats: ScanStats{
			Manifests:             len(manifests),
			DataFiles:             len(merged.DataFiles),
			DeleteFiles:           len(merged.DeleteFiles),
			IgnoredFutureEntries:  merged.IgnoredFutureEntries,
			IgnoredDeletedEntries: merged.IgnoredDeletedEntries,
			DeduplicatedEntries:   merged.DeduplicatedEntries,
		},
	}
	for _, manifest := range manifests {
		if manifest.Content == ManifestContentDeletes {
			plan.Stats.DeleteManifests++
		} else {
			plan.Stats.DataManifests++
		}
	}

	// Keep every live delete file.  Query predicates apply to data rows, not to
	// delete metadata, and a delete written under another (or no) partition spec
	// may still target a selected data file.
	plan.DeleteFiles = append(plan.DeleteFiles, merged.DeleteFiles...)

	selected := make([]*BoundFile, 0, len(merged.DataFiles))
	for _, data := range merged.DataFiles {
		dataSpec := p.partitionSpec(data.DataFile.EffectiveSpecID())
		if !DataFileMatches(data.DataFile, dataSpec, predicate) {
			plan.Stats.PrunedDataFiles++
			continue
		}
		selected = append(selected, data)
	}
	plan.DataFiles = selected

	boundDelete := make(map[string]*BoundFile)
	for _, data := range selected {
		dataSpec := p.partitionSpec(data.DataFile.EffectiveSpecID())
		task := &FileScanTask{
			DataFile:           data.DataFile,
			DataSequenceNumber: data.DataSequenceNumber,
			FileSequenceNumber: data.FileSequenceNumber,
			SpecID:             data.DataFile.EffectiveSpecID(),
		}
		for _, delete := range merged.DeleteFiles {
			deleteSpec := p.partitionSpec(delete.DataFile.EffectiveSpecID())
			if !DeleteApplies(data.DataSequenceNumber, delete.DataSequenceNumber, delete.Content()) {
				continue
			}
			if !DeleteMayMatchData(data.DataFile, dataSpec, delete.DataFile, deleteSpec) {
				continue
			}
			attachDelete(task, delete)
			boundDelete[manifestKey(delete.DataFile)] = delete
		}
		sortBoundFiles(task.DeleteFiles)
		plan.Tasks = append(plan.Tasks, task)
	}
	sort.SliceStable(plan.Tasks, func(i, j int) bool {
		return plan.Tasks[i].DataFile.FilePath < plan.Tasks[j].DataFile.FilePath
	})

	plan.Files = plan.Tasks
	for _, delete := range merged.DeleteFiles {
		if _, ok := boundDelete[manifestKey(delete.DataFile)]; ok {
			plan.BoundDeleteFiles = append(plan.BoundDeleteFiles, delete)
		} else {
			plan.UnboundDeleteFiles = append(plan.UnboundDeleteFiles, delete)
		}
	}
	sortBoundFiles(plan.BoundDeleteFiles)
	sortBoundFiles(plan.UnboundDeleteFiles)
	plan.Stats.BoundDeleteFiles = len(plan.BoundDeleteFiles)
	return plan, nil
}

func (p *Planner) loadLiveManifests(snapshot Snapshot, loader ManifestLoader, listLoader ManifestListLoader) ([]ManifestFile, error) {
	manifests, err := p.Table.LiveManifests(snapshot.SnapshotID)
	if err != nil {
		return nil, err
	}
	if len(manifests) == 0 && len(snapshot.Manifests) == 0 && snapshot.ManifestList != "" {
		if listLoader == nil {
			return nil, fmt.Errorf("%w: snapshot %d has manifest list %q",
				ErrManifestLoaderRequired, snapshot.SnapshotID, snapshot.ManifestList)
		}
		manifests, err = listLoader.LoadManifestList(snapshot)
		if err != nil {
			return nil, err
		}
		// Apply the same lineage/future guards as LiveManifests without
		// mutating the caller's table or snapshot.
		lineage, err := p.Table.Lineage(snapshot.SnapshotID)
		if err != nil {
			return nil, err
		}
		manifests = filterManifestsForSnapshot(manifests, &snapshot, lineage)
	}
	if loader == nil {
		loader = p.Loader
	}
	resolved := make([]ManifestFile, 0, len(manifests))
	for i := range manifests {
		manifest := manifests[i]
		if manifest.Entries == nil {
			if loader != nil {
				entries, err := loader.LoadManifest(manifest)
				if err != nil {
					return nil, fmt.Errorf("load manifest %s: %w", manifest.ManifestPath, err)
				}
				manifest.Entries = entries
			} else if manifest.AddedFiles+manifest.ExistingFiles+manifest.DeletedFiles == 0 {
				// An empty manifest list entry does not require I/O.
				manifest.Entries = []ManifestEntry{}
			} else {
				return nil, fmt.Errorf("%w: manifest %s",
					ErrManifestLoaderRequired, manifest.ManifestPath)
			}
		}
		resolved = append(resolved, manifest)
	}
	return resolved, nil
}

func (p *Planner) partitionSpec(id int) *PartitionSpec {
	if p.Table != nil {
		if spec, ok := p.Table.PartitionSpec(id); ok {
			return spec
		}
	}
	return &PartitionSpec{SpecID: id}
}

func attachDelete(task *FileScanTask, delete *BoundDeleteFile) {
	switch delete.Content() {
	case FileContentPositionDeletes:
		task.PositionDeletes = append(task.PositionDeletes, delete)
		task.PositionDeleteFiles = task.PositionDeletes
	case FileContentEqualityDeletes:
		task.EqualityDeletes = append(task.EqualityDeletes, delete)
		task.EqualityDeleteFiles = task.EqualityDeletes
	case FileContentDeletionVector:
		task.DeletionVectors = append(task.DeletionVectors, delete)
	default:
		return
	}
	task.DeleteFiles = append(task.DeleteFiles, delete)
}

// BuildPlan is the package-level convenience form of Planner.Plan.
func BuildPlan(table *Table, snapshotID int64, filter any) (*ScanPlan, error) {
	return NewPlanner(table).Plan(snapshotID, filter)
}

// Plan is an alias of BuildPlan.
func Plan(table *Table, snapshotID int64, filter any) (*ScanPlan, error) {
	return BuildPlan(table, snapshotID, filter)
}

// BuildCurrentPlan plans the current snapshot of table.
func BuildCurrentPlan(table *Table, filter any) (*ScanPlan, error) {
	return NewPlanner(table).PlanCurrent(filter)
}
