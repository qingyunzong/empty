package dataeng

import "fmt"

// ResolvedEntry is a manifest entry whose sequence numbers have been inherited
// from its manifest.  A resolved entry is what scan planning actually consumes.
type ResolvedEntry struct {
	Status             ManifestEntryStatus
	SnapshotID         int64
	DataSequenceNumber int64
	FileSequenceNumber int64
	DataFile           *DataFile
	ManifestPath       string
}

// ResolveEntry applies Iceberg's sequence inheritance rule:
//
//   - New entries are written with a null sequence number and inherit the
//     manifest's sequence number at read time.
//   - Existing entries normally carry an explicit sequence number.  If one is
//     missing, the manifest sequence is the only safe fallback.
//   - File sequence numbers are inherited independently from data sequence
//     numbers; a rewritten delete file may have a newer file sequence while
//     still deleting data at its original data sequence.
func ResolveEntry(entry ManifestEntry, manifest ManifestFile) (ResolvedEntry, error) {
	manifestSeq := manifest.SequenceNumber
	if manifestSeq < 0 {
		manifestSeq = InitialSequenceNumber
	}

	dataSeq := manifestSeq
	if entry.DataSequenceNumber != nil {
		dataSeq = *entry.DataSequenceNumber
	}
	if dataSeq == UnassignedSequenceNumber {
		dataSeq = manifestSeq
	}
	if dataSeq < 0 {
		return ResolvedEntry{}, fmt.Errorf("%w: entry data sequence %d in %s",
			ErrInvalidSequenceNumber, dataSeq, shortPath(manifest.ManifestPath))
	}

	fileSeq := manifestSeq
	if entry.FileSequenceNumber != nil {
		fileSeq = *entry.FileSequenceNumber
	}
	if fileSeq == UnassignedSequenceNumber {
		fileSeq = manifestSeq
	}
	if fileSeq < 0 {
		return ResolvedEntry{}, fmt.Errorf("%w: entry file sequence %d in %s",
			ErrInvalidSequenceNumber, fileSeq, shortPath(manifest.ManifestPath))
	}

	if entry.DataFile == nil {
		return ResolvedEntry{}, fmt.Errorf("%w: nil data file in %s",
			ErrInvalidManifest, shortPath(manifest.ManifestPath))
	}

	snapshotID := int64(0)
	if entry.SnapshotID != nil {
		snapshotID = *entry.SnapshotID
	} else if manifest.AddedSnapshotID != nil {
		snapshotID = *manifest.AddedSnapshotID
	}

	return ResolvedEntry{
		Status:             entry.Status,
		SnapshotID:         snapshotID,
		DataSequenceNumber: dataSeq,
		FileSequenceNumber: fileSeq,
		DataFile:           entry.DataFile,
		ManifestPath:       manifest.ManifestPath,
	}, nil
}

// ResolveManifest resolves every entry in a manifest.  Deleted entries are
// resolved too so callers can inspect tombstones, but MergeManifests drops them.
func ResolveManifest(manifest ManifestFile) ([]ResolvedEntry, error) {
	out := make([]ResolvedEntry, 0, len(manifest.Entries))
	for _, entry := range manifest.Entries {
		resolved, err := ResolveEntry(entry, manifest)
		if err != nil {
			return nil, err
		}
		out = append(out, resolved)
	}
	return out, nil
}

// DeleteApplies reports whether a delete file with deleteSequence applies to a
// data file with dataSequence.
//
// Position deletes and deletion vectors use <= so a delete in the same commit
// can remove rows that commit added.  Equality deletes use < because they match
// by value and must not erase rows that were inserted in the same commit.
func DeleteApplies(dataSequence, deleteSequence int64, content FileContent) bool {
	switch content {
	case FileContentPositionDeletes, FileContentDeletionVector:
		return dataSequence <= deleteSequence
	case FileContentEqualityDeletes:
		return dataSequence < deleteSequence
	default:
		return false
	}
}

// PositionDeleteApplies is the position-delete special case of DeleteApplies.
func PositionDeleteApplies(dataSequence, deleteSequence int64) bool {
	return dataSequence <= deleteSequence
}

// EqualityDeleteApplies is the equality-delete special case of DeleteApplies.
func EqualityDeleteApplies(dataSequence, deleteSequence int64) bool {
	return dataSequence < deleteSequence
}
