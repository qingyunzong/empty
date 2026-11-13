package dataeng

import (
	"fmt"
	"sort"
)

// SnapshotLineage returns the ancestor chain of snapshotID ordered from the
// requested snapshot to the root.  Only the parent links are followed.  This is
// deliberately different from "all snapshots in the catalog": after a rollback
// the descendants still exist but are not reachable from the current snapshot.
func SnapshotLineage(t *Table, snapshotID int64) ([]Snapshot, error) {
	if t == nil {
		return nil, fmt.Errorf("%w: nil table", ErrBrokenLineage)
	}
	if _, ok := t.Snapshot(snapshotID); !ok {
		return nil, fmt.Errorf("%w: %d", ErrSnapshotNotFound, snapshotID)
	}

	chain := make([]Snapshot, 0)
	seen := make(map[int64]struct{})
	next := snapshotID
	for {
		if _, duplicate := seen[next]; duplicate {
			return nil, fmt.Errorf("%w: cycle at snapshot %d", ErrBrokenLineage, next)
		}
		seen[next] = struct{}{}

		snapshot, ok := t.Snapshot(next)
		if !ok {
			return nil, fmt.Errorf("%w: missing parent snapshot %d", ErrBrokenLineage, next)
		}
		chain = append(chain, *snapshot)
		if snapshot.ParentSnapshotID == nil {
			break
		}
		next = *snapshot.ParentSnapshotID
	}
	return chain, nil
}

// Lineage is the Table method form of SnapshotLineage.
func (t *Table) Lineage(snapshotID int64) ([]Snapshot, error) {
	return SnapshotLineage(t, snapshotID)
}

// LineageIDs returns the ids in the lineage in the same order as SnapshotLineage.
func (t *Table) LineageIDs(snapshotID int64) ([]int64, error) {
	chain, err := SnapshotLineage(t, snapshotID)
	if err != nil {
		return nil, err
	}
	ids := make([]int64, len(chain))
	for i := range chain {
		ids[i] = chain[i].SnapshotID
	}
	return ids, nil
}

// LiveManifests returns the manifests that belong to snapshotID.  The snapshot's
// own manifest list is authoritative; the lineage is used only to reject
// manifests that were created by a descendant (which can happen if a planner is
// fed a mistakenly merged global manifest pool).
func (t *Table) LiveManifests(snapshotID int64) ([]ManifestFile, error) {
	snapshot, ok := t.Snapshot(snapshotID)
	if !ok {
		return nil, fmt.Errorf("%w: %d", ErrSnapshotNotFound, snapshotID)
	}
	lineage, err := SnapshotLineage(t, snapshotID)
	if err != nil {
		return nil, err
	}
	return filterManifestsForSnapshot(snapshot.Manifests, snapshot, lineage), nil
}

func filterManifestsForSnapshot(manifests []ManifestFile, snapshot *Snapshot, lineage []Snapshot) []ManifestFile {
	inLineage := make(map[int64]struct{}, len(lineage))
	for _, s := range lineage {
		inLineage[s.SnapshotID] = struct{}{}
	}

	out := make([]ManifestFile, 0, len(manifests))
	for _, manifest := range manifests {
		if manifest.SequenceNumber > snapshot.SequenceNumber && manifest.SequenceNumber > 0 {
			// A manifest newer than the snapshot cannot be part of its state.
			continue
		}
		if manifest.AddedSnapshotID != nil {
			if _, ok := inLineage[*manifest.AddedSnapshotID]; !ok {
				// The manifest was added by a snapshot on a different branch,
				// in the future, or by a now-rolled-back descendant.
				continue
			}
		}
		out = append(out, manifest)
	}
	return out
}

// BoundFile is a data or delete file whose data and file sequence numbers have
// been resolved and whose manifest provenance is known.
type BoundFile struct {
	DataFile           *DataFile
	DataSequenceNumber int64
	FileSequenceNumber int64
	SnapshotID         int64
	ManifestPath       string
}

// Content returns the file content kind.
func (f *BoundFile) Content() FileContent {
	if f == nil || f.DataFile == nil {
		return FileContentData
	}
	return f.DataFile.Content
}

// Path returns the file path.
func (f *BoundFile) Path() string {
	if f == nil || f.DataFile == nil {
		return ""
	}
	return f.DataFile.FilePath
}

// BoundDeleteFile is a resolved delete file.  It is an alias of BoundFile so
// APIs may use either name without conversions.
type BoundDeleteFile = BoundFile

// ManifestSet is the result of merging a snapshot's manifests.  It contains only
// live files: entries marked deleted are removed and duplicate live content is
// collapsed deterministically.
type ManifestSet struct {
	DataFiles   []*BoundFile
	DeleteFiles []*BoundFile
	// IgnoredFutureEntries counts entries whose sequence number is newer than
	// the requested snapshot.  They are never reused by a rolled-back scan.
	IgnoredFutureEntries int
	// IgnoredDeletedEntries counts tombstoned entries.
	IgnoredDeletedEntries int
	// DeduplicatedEntries counts live paths that appeared more than once.
	DeduplicatedEntries int
}

// MergedManifests is an alias for ManifestSet.
type MergedManifests = ManifestSet

// MergeManifests resolves, filters and merges manifest entries.  The optional
// sequence limit is normally the snapshot sequence number: entries newer than
// it are ignored.  Omitting the limit (or passing a negative value) disables
// that guard.
func MergeManifests(manifests []ManifestFile, sequenceLimits ...int64) (*ManifestSet, error) {
	seqLimit := int64(-1)
	if len(sequenceLimits) > 0 {
		seqLimit = sequenceLimits[0]
	}
	set := &ManifestSet{}
	byKey := make(map[string]*BoundFile)

	// Apply manifests in sequence order so a tombstone in a later manifest can
	// supersede an earlier live entry while a later re-add becomes live again.
	ordered := append([]ManifestFile(nil), manifests...)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].SequenceNumber != ordered[j].SequenceNumber {
			return ordered[i].SequenceNumber < ordered[j].SequenceNumber
		}
		return ordered[i].ManifestPath < ordered[j].ManifestPath
	})

	for i := range ordered {
		manifest := ordered[i]
		if seqLimit >= 0 && manifest.SequenceNumber > seqLimit && manifest.SequenceNumber > 0 {
			if manifest.Entries != nil {
				set.IgnoredFutureEntries += len(manifest.Entries)
			} else {
				set.IgnoredFutureEntries += manifest.AddedFiles + manifest.ExistingFiles + manifest.DeletedFiles
			}
			continue
		}
		for _, entry := range manifest.Entries {
			resolved, err := ResolveEntry(entry, manifest)
			if err != nil {
				return nil, err
			}
			if seqLimit >= 0 && resolved.DataSequenceNumber > seqLimit {
				set.IgnoredFutureEntries++
				continue
			}
			if entry.Status == EntryStatusDeleted {
				delete(byKey, manifestKey(resolved.DataFile))
				set.IgnoredDeletedEntries++
				continue
			}

			// Copy the metadata before filling in manifest-derived fields so
			// concurrent plans can share the same manifest literals safely.
			fileCopy := *resolved.DataFile
			file := &fileCopy
			// A manifest has exactly one partition spec.  Honour the manifest's
			// spec unless the caller supplied an explicit non-zero file spec and
			// the manifest itself is spec 0.
			if manifest.PartitionSpecID != 0 || file.SpecID == 0 {
				file.SpecID = manifest.PartitionSpecID
			}
			bound := &BoundFile{
				DataFile:           file,
				DataSequenceNumber: resolved.DataSequenceNumber,
				FileSequenceNumber: resolved.FileSequenceNumber,
				SnapshotID:         resolved.SnapshotID,
				ManifestPath:       resolved.ManifestPath,
			}
			key := manifestKey(file)
			if existing, ok := byKey[key]; ok {
				set.DeduplicatedEntries++
				// Live duplicates are a metadata error, but if a caller merges
				// overlapping histories the newest binding wins.  Never let a
				// duplicate lower the sequence of an existing file.
				if newerBinding(bound, existing) {
					byKey[key] = bound
				}
				continue
			}
			byKey[key] = bound
		}
	}

	set.DataFiles = make([]*BoundFile, 0, len(byKey))
	set.DeleteFiles = make([]*BoundFile, 0, len(byKey))
	for _, bound := range byKey {
		if bound.Content().IsDelete() {
			set.DeleteFiles = append(set.DeleteFiles, bound)
		} else {
			set.DataFiles = append(set.DataFiles, bound)
		}
	}
	sortBoundFiles(set.DataFiles)
	sortBoundFiles(set.DeleteFiles)
	return set, nil
}

func manifestKey(file *DataFile) string {
	return fmt.Sprintf("%d\x00%s", int32(file.Content), file.FilePath)
}

func newerBinding(candidate, existing *BoundFile) bool {
	if candidate.DataSequenceNumber != existing.DataSequenceNumber {
		return candidate.DataSequenceNumber > existing.DataSequenceNumber
	}
	if candidate.FileSequenceNumber != existing.FileSequenceNumber {
		return candidate.FileSequenceNumber > existing.FileSequenceNumber
	}
	return candidate.ManifestPath < existing.ManifestPath
}

func sortBoundFiles(files []*BoundFile) {
	sort.SliceStable(files, func(i, j int) bool {
		if files[i].Content() != files[j].Content() {
			return files[i].Content() < files[j].Content()
		}
		if files[i].Path() != files[j].Path() {
			return files[i].Path() < files[j].Path()
		}
		return files[i].DataSequenceNumber < files[j].DataSequenceNumber
	})
}

// MergeSnapshot returns the merged live manifest set for a snapshot.
func (t *Table) MergeSnapshot(snapshotID int64) (*ManifestSet, error) {
	snapshot, ok := t.Snapshot(snapshotID)
	if !ok {
		return nil, fmt.Errorf("%w: %d", ErrSnapshotNotFound, snapshotID)
	}
	manifests, err := t.LiveManifests(snapshotID)
	if err != nil {
		return nil, err
	}
	return MergeManifests(manifests, snapshot.SequenceNumber)
}
