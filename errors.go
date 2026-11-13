package dataeng

import "errors"

var (
	// ErrSnapshotNotFound is returned when a snapshot id is not in the table.
	ErrSnapshotNotFound = errors.New("dataeng: snapshot not found")
	// ErrNoCurrentSnapshot is returned when planning without a current snapshot.
	ErrNoCurrentSnapshot = errors.New("dataeng: table has no current snapshot")
	// ErrBrokenLineage is returned when a parent snapshot is missing or the
	// snapshot graph contains a cycle.
	ErrBrokenLineage = errors.New("dataeng: broken snapshot lineage")
	// ErrInvalidManifest is returned for malformed manifest metadata.
	ErrInvalidManifest = errors.New("dataeng: invalid manifest")
	// ErrInvalidSequenceNumber is returned when a sequence cannot be inherited.
	ErrInvalidSequenceNumber = errors.New("dataeng: invalid sequence number")
	// ErrManifestLoaderRequired is returned when manifest entries were not
	// embedded and no loader was supplied.
	ErrManifestLoaderRequired = errors.New("dataeng: manifest loader required")
)
