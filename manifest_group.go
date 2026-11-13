package dataeng

import "fmt"

// ManifestGroup is a convenience view over a snapshot's data and delete
// manifests.  Merging a group applies the same inheritance, tombstone and
// sequence-limit rules as Planner.
type ManifestGroup struct {
	DataManifests   []ManifestFile
	DeleteManifests []ManifestFile
}

// NewManifestGroup partitions manifests by content into a group.
func NewManifestGroup(manifests ...ManifestFile) *ManifestGroup {
	group := &ManifestGroup{}
	for _, manifest := range manifests {
		if manifest.Content == ManifestContentDeletes {
			group.DeleteManifests = append(group.DeleteManifests, manifest)
		} else {
			group.DataManifests = append(group.DataManifests, manifest)
		}
	}
	return group
}

// Manifests returns data manifests followed by delete manifests.
func (g *ManifestGroup) Manifests() []ManifestFile {
	if g == nil {
		return nil
	}
	out := make([]ManifestFile, 0, len(g.DataManifests)+len(g.DeleteManifests))
	out = append(out, g.DataManifests...)
	out = append(out, g.DeleteManifests...)
	return out
}

// Merge resolves the group.  A negative sequence limit disables the future
// guard; normally pass the snapshot's sequence number.
func (g *ManifestGroup) Merge(sequenceLimit int64) (*ManifestSet, error) {
	if g == nil {
		return nil, fmt.Errorf("%w: nil manifest group", ErrInvalidManifest)
	}
	return MergeManifests(g.Manifests(), sequenceLimit)
}

// MergeSnapshotManifests merges an already-loaded snapshot.  When sequenceLimit
// is omitted, the snapshot's own sequence number is used, which prevents any
// entry from a future commit from being reused.
func MergeSnapshotManifests(snapshot Snapshot, sequenceLimit ...int64) (*ManifestSet, error) {
	limit := snapshot.SequenceNumber
	if len(sequenceLimit) > 0 {
		limit = sequenceLimit[0]
	}
	return MergeManifests(snapshot.Manifests, limit)
}
