package dataeng

import "time"

// Partition is the storage partition a data file belongs to. Compaction only
// ever selects files that share the same partition value.
type Partition string

// FileID is the unique path-based identity of a data file.
type FileID string

// DataFile is a single physical data file tracked by the table.
type DataFile struct {
	// Path is the unique identifier of the file inside the table.
	Path string

	// Partition is the partition the file belongs to.
	Partition Partition

	// SizeInBytes is the physical size of the file, used for planning bounds.
	SizeInBytes int64

	// RecordCount is the number of records contained in the file.
	RecordCount int64
}

// RecycleReason classifies why a file was placed on the safe-to-recycle list.
type RecycleReason string

const (
	// RecycleFailedOutput marks files produced by a failed compaction. They
	// never entered the manifest and may be deleted immediately.
	RecycleFailedOutput RecycleReason = "failed-output"

	// RecycleReplacedInput marks input files replaced by a committed
	// compaction. They leave the active set but remain reachable from older
	// snapshots until snapshot expiration.
	RecycleReplacedInput RecycleReason = "replaced-input"
)

// RecycleItem is a single entry on the safe-to-recycle list. Callers use this
// list to drive physical garbage collection without inspecting internals.
type RecycleItem struct {
	// Path identifies the physical file that can be reclaimed.
	Path string

	// Partition is the partition the file belonged to.
	Partition Partition

	// Reason explains why the file became recyclable.
	Reason RecycleReason

	// PlanID is the compaction plan that produced the entry. Empty for items
	// not tied to a plan.
	PlanID string

	// SnapshotID is the snapshot that made the entry obsolete. It is zero for
	// failed outputs because they never entered any manifest snapshot.
	SnapshotID int64

	// Immediately is true when the file was never part of an active manifest
	// and can be deleted without waiting for snapshot expiration.
	Immediately bool

	// CreatedAt records when the entry was added to the recycle list.
	CreatedAt time.Time
}

// Snapshot is an immutable point-in-time view of the table. Each successful
// manifest change appends a new snapshot rather than mutating an old one.
type Snapshot struct {
	// ID is the monotonically increasing snapshot identifier.
	ID int64

	// ParentID is the snapshot this one was derived from.
	ParentID int64

	// CreatedAt is the time the snapshot was produced.
	CreatedAt time.Time

	// AddedFiles are the files that became active in this snapshot.
	AddedFiles []DataFile

	// RemovedFiles are the files that stopped being active in this snapshot.
	RemovedFiles []DataFile
}

// Manifest is the active materialized view of the table.
type Manifest struct {
	// SnapshotID is the snapshot the active file set corresponds to.
	SnapshotID int64

	// Files are all currently active data files.
	Files []DataFile
}

// ReplacementSet describes the rewrite produced by a compaction: the active
// input files that are removed and the output files that replace them.
type ReplacementSet struct {
	// Inputs are the active files selected for compaction.
	Inputs []DataFile

	// Outputs are the files produced by the physical compaction job. They only
	// become active once the plan commits successfully.
	Outputs []DataFile
}

// Plan status lifecycle values.
const (
	// PlanPlanned means the plan exists and its inputs are claimed (when
	// claim-based isolation is enabled).
	PlanPlanned = "planned"

	// PlanCommitted means the replacement set was applied and a new snapshot
	// was appended.
	PlanCommitted = "committed"

	// PlanFailed means the physical job failed; outputs were recorded for
	// recycling and never entered the manifest.
	PlanFailed = "failed"

	// PlanAborted means the plan was canceled without producing outputs.
	PlanAborted = "aborted"
)

// CompactionPlan is the state record for a single compaction attempt.
type CompactionPlan struct {
	// ID uniquely identifies the plan.
	ID string

	// Partition is the single partition the plan compacts.
	Partition Partition

	// BaseSnapshotID is the snapshot the plan was planned against.
	BaseSnapshotID int64

	// Status is the current lifecycle state (one of the Plan* constants).
	Status string

	// Replacement records the selected inputs and, after a successful commit,
	// the outputs that replaced them.
	Replacement ReplacementSet

	// CommitSnapshotID is set to the new snapshot id after a successful commit
	// and remains zero until then.
	CommitSnapshotID int64

	// CreatedAt records when the plan was created.
	CreatedAt time.Time

	// UpdatedAt records the last lifecycle transition.
	UpdatedAt time.Time

	// claimed indicates whether the plan currently occupies its input files.
	// Only meaningful while Status == PlanPlanned.
	claimed bool
}

// PlanOptions tunes file selection for a compaction plan.
type PlanOptions struct {
	// PlanID optionally pins the plan identifier. When empty an id is
	// generated automatically.
	PlanID string

	// MinFiles is the minimum number of eligible files required to plan. When
	// zero it defaults to two, since a single file does not need compaction.
	MinFiles int

	// MaxFiles caps how many files a plan may select. Zero means unbounded.
	MaxFiles int

	// MaxTotalSizeInBytes caps the cumulative size of selected files. Zero
	// means unbounded.
	MaxTotalSizeInBytes int64

	// NoClaim disables occupancy claiming for the plan. The plan still
	// participates in optimistic concurrency control at commit time, which is
	// useful for integrating with external lock managers.
	NoClaim bool
}

// CommitResult summarizes a successful commit.
type CommitResult struct {
	// PlanID is the plan that committed.
	PlanID string

	// SnapshotID is the newly appended snapshot.
	SnapshotID int64

	// Removed are the input files removed from the active set.
	Removed []DataFile

	// Added are the output files added to the active set.
	Added []DataFile
}
