package dataeng

import (
	"fmt"
	"strings"
)

// SequenceNumber is the logical commit sequence that orders data and delete
// files.  The value is inherited from the snapshot that first added a file and
// must never change when manifests are rewritten.
type SequenceNumber = int64

const (
	// UnassignedSequenceNumber is used in manifest entries to mean "inherit the
	// sequence number from the manifest file".
	UnassignedSequenceNumber int64 = -1
	// InitialSequenceNumber is the sequence number of format v1 tables.
	InitialSequenceNumber int64 = 0
)

// FileContent identifies the kind of file described by a manifest entry.
type FileContent int32

const (
	FileContentData FileContent = iota
	FileContentPositionDeletes
	FileContentEqualityDeletes
	FileContentDeletionVector
)

// Short aliases follow the names used by the Iceberg specification and by the
// reference implementations.
const (
	EntryContentData            = FileContentData
	EntryContentPositionDeletes = FileContentPositionDeletes
	EntryContentEqualityDeletes = FileContentEqualityDeletes
	EntryContentDeletionVector  = FileContentDeletionVector
)

func (c FileContent) String() string {
	switch c {
	case FileContentData:
		return "data"
	case FileContentPositionDeletes:
		return "position-deletes"
	case FileContentEqualityDeletes:
		return "equality-deletes"
	case FileContentDeletionVector:
		return "deletion-vector"
	default:
		return fmt.Sprintf("file-content(%d)", int32(c))
	}
}

// IsDelete reports whether c is any row-level delete representation.
func (c FileContent) IsDelete() bool {
	return c == FileContentPositionDeletes ||
		c == FileContentEqualityDeletes ||
		c == FileContentDeletionVector
}

// ManifestContent identifies whether a manifest contains data or delete files.
type ManifestContent int32

const (
	ManifestContentData ManifestContent = iota
	ManifestContentDeletes
)

// Short aliases for callers that use the spec names.
const (
	ManifestData    = ManifestContentData
	ManifestDeletes = ManifestContentDeletes
)

func (c ManifestContent) String() string {
	if c == ManifestContentDeletes {
		return "deletes"
	}
	return "data"
}

// ManifestEntryStatus is the status of a file entry inside a manifest.
type ManifestEntryStatus int32

const (
	EntryStatusExisting ManifestEntryStatus = iota
	EntryStatusAdded
	EntryStatusDeleted
)

// Short aliases matching the uppercase spelling used by some Iceberg clients.
const (
	EntryStatusEXISTING = EntryStatusExisting
	EntryStatusADDED    = EntryStatusAdded
	EntryStatusDELETED  = EntryStatusDeleted
)

func (s ManifestEntryStatus) String() string {
	switch s {
	case EntryStatusExisting:
		return "existing"
	case EntryStatusAdded:
		return "added"
	case EntryStatusDeleted:
		return "deleted"
	default:
		return fmt.Sprintf("entry-status(%d)", int32(s))
	}
}

// FileFormat is the physical format of a data or delete file.
type FileFormat string

const (
	FormatParquet FileFormat = "PARQUET"
	FormatORC     FileFormat = "ORC"
	FormatAvro    FileFormat = "AVRO"
	FormatPuffin  FileFormat = "PUFFIN"
)

// Transform is the partition transform applied by a partition field.
type Transform string

const (
	TransformIdentity Transform = "identity"
	TransformVoid     Transform = "void"
)

// Partition is a partition tuple keyed by the partition field name.  Keeping
// values available by name makes plans readable and lets callers supply
// predicates without knowing a particular spec's field order.
type Partition map[string]any

// PartitionData is the field-id keyed representation used by Iceberg metadata.
// A DataFile may carry either representation; PartitionFor resolves both.
type PartitionData map[int]any

// PartitionField describes one field of a partition spec.
type PartitionField struct {
	SourceID  int       `json:"source-id"`
	FieldID   int       `json:"field-id,omitempty"`
	Name      string    `json:"name"`
	Transform Transform `json:"transform"`
}

// PartitionSpec describes how table rows are partitioned.
type PartitionSpec struct {
	SpecID int              `json:"spec-id"`
	Fields []PartitionField `json:"fields"`
}

// IsUnpartitioned reports whether the spec has no effective partition fields.
// A spec containing only void transforms is unpartitioned for scan planning.
func (s *PartitionSpec) IsUnpartitioned() bool {
	if s == nil {
		return true
	}
	for _, f := range s.Fields {
		if f.Transform != TransformVoid {
			return false
		}
	}
	return true
}

// Field returns a partition field by name.
func (s *PartitionSpec) Field(name string) (PartitionField, bool) {
	if s == nil {
		return PartitionField{}, false
	}
	for _, f := range s.Fields {
		if f.Name == name {
			return f, true
		}
	}
	return PartitionField{}, false
}

// DataFile is the metadata for a data file, position delete file, equality
// delete file, or deletion vector.  Only the fields relevant to scan planning
// are modeled; the remaining metadata is preserved for callers.
type DataFile struct {
	Content       FileContent   `json:"content"`
	FilePath      string        `json:"file-path"`
	FileFormat    FileFormat    `json:"file-format"`
	Partition     Partition     `json:"partition,omitempty"`
	PartitionData PartitionData `json:"partition-data,omitempty"`
	SpecID        int           `json:"spec-id,omitempty"`
	// PartitionSpecID is an alternate spelling accepted for callers building
	// metadata by hand.  EffectiveSpecID resolves the two fields.
	PartitionSpecID    int               `json:"partition-spec-id,omitempty"`
	RecordCount        int64             `json:"record-count"`
	FileSizeInBytes    int64             `json:"file-size-in-bytes"`
	ColumnSizes        map[int]int64     `json:"column-sizes,omitempty"`
	ValueCounts        map[int]int64     `json:"value-counts,omitempty"`
	NullValueCounts    map[int]int64     `json:"null-value-counts,omitempty"`
	NanValueCounts     map[int]int64     `json:"nan-value-counts,omitempty"`
	LowerBoundValues   map[int][]byte    `json:"lower-bound-values,omitempty"`
	UpperBoundValues   map[int][]byte    `json:"upper-bound-values,omitempty"`
	KeyMetadata        []byte            `json:"key-metadata,omitempty"`
	SplitOffsets       []int64           `json:"split-offsets,omitempty"`
	EqualityFieldIDs   []int             `json:"equality-ids,omitempty"`
	EqualityIDs        []int             `json:"equality-ids-alias,omitempty"`
	SortOrderID        *int              `json:"sort-order-id,omitempty"`
	ReferencedDataFile string            `json:"referenced-data-file,omitempty"`
	ContentOffset      *int64            `json:"content-offset,omitempty"`
	ContentSizeInBytes *int64            `json:"content-size-in-bytes,omitempty"`
	UserMetadata       map[string]string `json:"user-metadata,omitempty"`
}

// EffectiveSpecID returns SpecID, falling back to PartitionSpecID.
func (f *DataFile) EffectiveSpecID() int {
	if f == nil {
		return 0
	}
	if f.SpecID != 0 {
		return f.SpecID
	}
	return f.PartitionSpecID
}

// DeleteFile is the data-file metadata shape used for every delete content kind.
// Callers may construct it directly and set Content.
type DeleteFile = DataFile

// PositionDeleteFile and EqualityDeleteFile are descriptive aliases of the
// same metadata shape.
type PositionDeleteFile = DataFile
type EqualityDeleteFile = DataFile

// NewDataFile returns a data file with the common fields populated.
func NewDataFile(path string, specID int, partition Partition) *DataFile {
	return &DataFile{
		Content:    FileContentData,
		FilePath:   path,
		FileFormat: FormatParquet,
		SpecID:     specID,
		Partition:  partition,
	}
}

// NewPositionDeleteFile returns a position delete file.  When referencedDataFile
// is non-empty the delete is file scoped (as used by deletion vectors and
// file-scoped position deletes).
func NewPositionDeleteFile(path, referencedDataFile string, specID int, partition Partition) *DataFile {
	return &DataFile{
		Content:            FileContentPositionDeletes,
		FilePath:           path,
		FileFormat:         FormatParquet,
		SpecID:             specID,
		Partition:          partition,
		ReferencedDataFile: referencedDataFile,
	}
}

// NewEqualityDeleteFile returns an equality delete file.
func NewEqualityDeleteFile(path string, equalityFieldIDs []int, specID int, partition Partition) *DataFile {
	return &DataFile{
		Content:          FileContentEqualityDeletes,
		FilePath:         path,
		FileFormat:       FormatParquet,
		SpecID:           specID,
		Partition:        partition,
		EqualityFieldIDs: append([]int(nil), equalityFieldIDs...),
	}
}

// PartitionFor returns the partition tuple as a name-keyed map.  PartitionData
// (field-id keyed) is projected through spec when necessary.
func (f *DataFile) PartitionFor(spec *PartitionSpec) Partition {
	if f == nil {
		return nil
	}
	if len(f.Partition) > 0 {
		return f.Partition
	}
	if len(f.PartitionData) == 0 {
		return nil
	}
	out := make(Partition, len(f.PartitionData))
	if spec != nil {
		for _, field := range spec.Fields {
			if v, ok := f.PartitionData[field.FieldID]; ok {
				out[field.Name] = v
			} else if v, ok := f.PartitionData[field.SourceID]; ok {
				out[field.Name] = v
			}
		}
	}
	if len(out) == 0 {
		for id, v := range f.PartitionData {
			out[fmt.Sprintf("%d", id)] = v
		}
	}
	return out
}

// ManifestEntry is one entry in a manifest file.  Nil sequence numbers inherit
// the corresponding sequence from the manifest.
type ManifestEntry struct {
	Status             ManifestEntryStatus `json:"status"`
	SnapshotID         *int64              `json:"snapshot-id,omitempty"`
	DataSequenceNumber *int64              `json:"data-sequence-number,omitempty"`
	FileSequenceNumber *int64              `json:"file-sequence-number,omitempty"`
	DataFile           *DataFile           `json:"data-file,omitempty"`
}

// SequenceNumber is a convenience alias for DataSequenceNumber.  It is only
// consulted when DataSequenceNumber is nil.
func (e *ManifestEntry) SequenceNumber() *int64 {
	if e == nil {
		return nil
	}
	return e.DataSequenceNumber
}

// ManifestFile is an entry in a snapshot's manifest list.  Entries is optional:
// when set, the manifest contents are already loaded (useful for tests and
// in-process planners); otherwise a ManifestLoader is used.
type ManifestFile struct {
	ManifestPath      string          `json:"manifest-path"`
	ManifestLength    int64           `json:"manifest-length"`
	PartitionSpecID   int             `json:"partition-spec-id"`
	Content           ManifestContent `json:"content"`
	SequenceNumber    int64           `json:"sequence-number"`
	MinSequenceNumber int64           `json:"min-sequence-number"`
	AddedSnapshotID   *int64          `json:"added-snapshot-id,omitempty"`
	AddedFiles        int             `json:"added-files,omitempty"`
	ExistingFiles     int             `json:"existing-files,omitempty"`
	DeletedFiles      int             `json:"deleted-files,omitempty"`
	Entries           []ManifestEntry `json:"entries,omitempty"`
}

// Path is a convenience accessor for ManifestPath.
func (m *ManifestFile) Path() string {
	if m == nil {
		return ""
	}
	return m.ManifestPath
}

// SpecID is a convenience accessor for PartitionSpecID.
func (m *ManifestFile) SpecID() int {
	if m == nil {
		return 0
	}
	return m.PartitionSpecID
}

// Snapshot is a point-in-time table state.  Manifests is the snapshot's live
// manifest list.  It is intentionally the only source of manifests used by the
// planner so a rollback cannot accidentally read delete files from descendants.
type Snapshot struct {
	SnapshotID       int64             `json:"snapshot-id"`
	ParentSnapshotID *int64            `json:"parent-snapshot-id,omitempty"`
	SequenceNumber   int64             `json:"sequence-number"`
	TimestampMs      int64             `json:"timestamp-ms"`
	ManifestList     string            `json:"manifest-list,omitempty"`
	Manifests        []ManifestFile    `json:"manifests,omitempty"`
	Summary          map[string]string `json:"summary,omitempty"`
	SchemaID         *int              `json:"schema-id,omitempty"`
	Operation        string            `json:"operation,omitempty"`
}

// Manifest and SnapshotManifest are aliases for ManifestFile.
type Manifest = ManifestFile
type SnapshotManifest = ManifestFile

// ParentID returns the parent snapshot id, if any.
func (s *Snapshot) ParentID() (int64, bool) {
	if s == nil || s.ParentSnapshotID == nil {
		return 0, false
	}
	return *s.ParentSnapshotID, true
}

// Field is a column in a table schema.
type Field struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Required bool   `json:"required,omitempty"`
}

// Schema is a table schema.
type Schema struct {
	SchemaID int     `json:"schema-id"`
	Fields   []Field `json:"fields"`
}

// FieldByName returns a schema field by name.
func (s *Schema) FieldByName(name string) (Field, bool) {
	if s == nil {
		return Field{}, false
	}
	for _, f := range s.Fields {
		if f.Name == name {
			return f, true
		}
	}
	return Field{}, false
}

// Table is an in-memory Iceberg-like table metadata catalog.  It intentionally
// keeps every snapshot, including snapshots that are no longer in the current
// lineage, so rollback and time-travel can be tested faithfully.
type Table struct {
	FormatVersion     int               `json:"format-version"`
	Location          string            `json:"location,omitempty"`
	CurrentSnapshotID *int64            `json:"current-snapshot-id,omitempty"`
	Snapshots         []Snapshot        `json:"snapshots"`
	PartitionSpecs    []PartitionSpec   `json:"partition-specs"`
	Schemas           []Schema          `json:"schemas"`
	Properties        map[string]string `json:"properties,omitempty"`

	snapshotByID map[int64]*Snapshot
	specByID     map[int]*PartitionSpec
	schemaByID   map[int]*Schema
}

// Metadata and TableMetadata are aliases for Table, matching the name used by
// Iceberg table metadata documents.
type Metadata = Table
type TableMetadata = Table

// NewTable returns an empty table with the usual defaults.
func NewTable() *Table {
	return &Table{
		FormatVersion: 2,
		snapshotByID:  make(map[int64]*Snapshot),
		specByID:      make(map[int]*PartitionSpec),
		schemaByID:    make(map[int]*Schema),
	}
}

// NewMetadata is an alias of NewTable.
func NewMetadata() *Table { return NewTable() }

// AddSnapshot appends a snapshot and updates indexes.  Snapshot ids are unique.
func (t *Table) AddSnapshot(s Snapshot) *Table {
	if t.snapshotByID == nil {
		t.snapshotByID = make(map[int64]*Snapshot)
	}
	for i := range t.Snapshots {
		if t.Snapshots[i].SnapshotID == s.SnapshotID {
			t.Snapshots[i] = s
			t.reindexSnapshots()
			return t
		}
	}
	t.Snapshots = append(t.Snapshots, s)
	t.reindexSnapshots()
	return t
}

// AddPartitionSpec appends or replaces a partition spec.
func (t *Table) AddPartitionSpec(spec PartitionSpec) *Table {
	for i := range t.PartitionSpecs {
		if t.PartitionSpecs[i].SpecID == spec.SpecID {
			t.PartitionSpecs[i] = spec
			t.reindexSpecs()
			return t
		}
	}
	t.PartitionSpecs = append(t.PartitionSpecs, spec)
	t.reindexSpecs()
	return t
}

// AddSchema appends or replaces a schema.
func (t *Table) AddSchema(schema Schema) *Table {
	for i := range t.Schemas {
		if t.Schemas[i].SchemaID == schema.SchemaID {
			t.Schemas[i] = schema
			t.reindexSchemas()
			return t
		}
	}
	t.Schemas = append(t.Schemas, schema)
	t.reindexSchemas()
	return t
}

// SetCurrentSnapshot points the table at an existing snapshot.  It is the
// metadata operation performed by a rollback; the newer snapshots remain in
// the catalog but are no longer in the current snapshot lineage.
func (t *Table) SetCurrentSnapshot(id int64) error {
	if _, ok := t.Snapshot(id); !ok {
		return fmt.Errorf("%w: %d", ErrSnapshotNotFound, id)
	}
	v := id
	t.CurrentSnapshotID = &v
	return nil
}

// RollbackToSnapshot points the table at an existing snapshot.  Descendant
// snapshots are retained but are not part of the new current lineage.
func (t *Table) RollbackToSnapshot(id int64) error {
	return t.SetCurrentSnapshot(id)
}

// RollbackToTimestamp points the table at the newest snapshot whose timestamp
// is less than or equal to ts.  Ties are resolved by the later snapshot in
// history order.
func (t *Table) RollbackToTimestamp(ts int64) error {
	var best *Snapshot
	for i := range t.Snapshots {
		s := &t.Snapshots[i]
		if s.TimestampMs > ts {
			continue
		}
		if best == nil || s.TimestampMs >= best.TimestampMs {
			best = s
		}
	}
	if best == nil {
		return fmt.Errorf("%w: timestamp %d", ErrSnapshotNotFound, ts)
	}
	return t.SetCurrentSnapshot(best.SnapshotID)
}

// Snapshot returns a snapshot by id.
func (t *Table) Snapshot(id int64) (*Snapshot, bool) {
	if t == nil {
		return nil, false
	}
	if t.snapshotByID != nil {
		if s, ok := t.snapshotByID[id]; ok {
			return s, true
		}
	}
	for i := range t.Snapshots {
		if t.Snapshots[i].SnapshotID == id {
			return &t.Snapshots[i], true
		}
	}
	return nil, false
}

// Current returns the current snapshot.
func (t *Table) Current() (*Snapshot, bool) {
	if t == nil || t.CurrentSnapshotID == nil {
		return nil, false
	}
	return t.Snapshot(*t.CurrentSnapshotID)
}

// PartitionSpec returns a partition spec by id.  A missing id yields an empty
// unpartitioned spec and false.
func (t *Table) PartitionSpec(id int) (*PartitionSpec, bool) {
	if t == nil {
		return nil, false
	}
	if t.specByID != nil {
		if s, ok := t.specByID[id]; ok {
			return s, true
		}
	}
	for i := range t.PartitionSpecs {
		if t.PartitionSpecs[i].SpecID == id {
			return &t.PartitionSpecs[i], true
		}
	}
	return nil, false
}

// Schema returns a schema by id.
func (t *Table) Schema(id int) (*Schema, bool) {
	if t == nil {
		return nil, false
	}
	if t.schemaByID != nil {
		if s, ok := t.schemaByID[id]; ok {
			return s, true
		}
	}
	for i := range t.Schemas {
		if t.Schemas[i].SchemaID == id {
			return &t.Schemas[i], true
		}
	}
	return nil, false
}

// EnsureIndices rebuilds all internal indexes after direct field mutation.
func (t *Table) EnsureIndices() {
	t.reindexSnapshots()
	t.reindexSpecs()
	t.reindexSchemas()
}

func (t *Table) reindexSnapshots() {
	t.snapshotByID = make(map[int64]*Snapshot, len(t.Snapshots))
	for i := range t.Snapshots {
		t.snapshotByID[t.Snapshots[i].SnapshotID] = &t.Snapshots[i]
	}
}

func (t *Table) reindexSpecs() {
	t.specByID = make(map[int]*PartitionSpec, len(t.PartitionSpecs))
	for i := range t.PartitionSpecs {
		t.specByID[t.PartitionSpecs[i].SpecID] = &t.PartitionSpecs[i]
	}
}

func (t *Table) reindexSchemas() {
	t.schemaByID = make(map[int]*Schema, len(t.Schemas))
	for i := range t.Schemas {
		t.schemaByID[t.Schemas[i].SchemaID] = &t.Schemas[i]
	}
}

// shortPath returns the final path component for readable diagnostics.
func shortPath(path string) string {
	if i := strings.LastIndexAny(path, `/\`); i >= 0 {
		return path[i+1:]
	}
	return path
}
