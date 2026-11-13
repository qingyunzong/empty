package dataeng

// DataFile identifies a data file participating in a scan.
//
// SequenceNumber is Iceberg's data sequence number: the sequence number that
// was assigned when the data file was added (or inherited by a rewrite).
// Sequence numbers are non-negative; larger values are newer.
//
// RowCount is optional reader metadata. The planner does not use it to reject
// or truncate positions; it is preserved in FilePlan for the caller.
type DataFile struct {
	Path           string
	SequenceNumber int64
	RowCount       int64
}

// PositionDelete is one row from an Iceberg position delete file. Position is
// a zero-based row index in the data file named by FilePath.
type PositionDelete struct {
	FilePath string
	Position int64
}

// PositionDeleteRecord is an alternate name for PositionDelete.
type PositionDeleteRecord = PositionDelete

// DeleteFile describes one position delete file and its records.
//
// SequenceNumber is the delete file's sequence number. Zero means "inherit the
// sequence number of the snapshot that introduced the file"; this is convenient
// when the caller does not repeat metadata that the snapshot already carries.
//
// SnapshotID is informational when planning after Catalog.VisibleDeleteFiles
// has resolved the lineage. It is filled in automatically when zero.
type DeleteFile struct {
	Path           string
	SequenceNumber int64
	SnapshotID     int64
	Records        []PositionDelete
}

// Snapshot is one node in an Iceberg snapshot graph.
//
// ParentID is zero for a root snapshot and otherwise must name another
// snapshot in the catalog. Branches are represented by their head snapshot ID;
// a branch inherits only the delete files that are visible along its parent
// chain.
//
// DeleteFiles contains delete files introduced (or made visible) by this
// snapshot. RemovedDeleteFiles contains delete file paths that this snapshot
// removed from visibility. Both slices are interpreted in this snapshot and
// inherited by descendants.
type Snapshot struct {
	ID                 int64
	ParentID           int64
	SequenceNumber     int64
	DeleteFiles        []DeleteFile
	RemovedDeleteFiles []string
}

// SnapshotInfo is an immutable copy of a snapshot returned by Catalog.
type SnapshotInfo = Snapshot
