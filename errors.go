package dataeng

import (
	"archive/tar"
	"errors"
	"fmt"
)

var (
	// ErrHeader is returned for malformed tar or sparse-map headers. It is
	// the same sentinel used by archive/tar.
	ErrHeader = tar.ErrHeader

	// ErrInvalidSparseMap is returned when extents are negative, unordered,
	// overlapping, overflow, or extend beyond the logical file size.
	ErrInvalidSparseMap = fmt.Errorf("dataeng: invalid sparse map: %w", tar.ErrHeader)

	// ErrInvalidPAX is returned for malformed PAX records.
	ErrInvalidPAX = fmt.Errorf("dataeng: invalid PAX records: %w", tar.ErrHeader)

	// ErrUnsupportedSparseVersion is returned for a GNU.sparse version other
	// than PAX 0.0, PAX 0.1, PAX 1.0, or the legacy GNU header form.
	ErrUnsupportedSparseVersion = fmt.Errorf("dataeng: unsupported GNU sparse version: %w", tar.ErrHeader)

	// ErrSizeMismatch is returned when the compact data referenced by the
	// sparse map does not exactly match the entry-body size.
	ErrSizeMismatch = fmt.Errorf("dataeng: sparse map does not match entry size: %w", tar.ErrHeader)

	// ErrSparseMapTooLong is returned when a sparse map exceeds the safety
	// limits used by the reader.
	ErrSparseMapTooLong = fmt.Errorf("dataeng: sparse map too long: %w", tar.ErrHeader)

	// ErrNotRandomAccess is returned when ReadAt is used on a sparse reader
	// whose compact data source is streaming-only.
	ErrNotRandomAccess = errors.New("dataeng: compact data is not random-access")

	// Validation aliases. All wrap ErrHeader so callers may test either the
	// detailed sentinel or archive/tar.ErrHeader.
	ErrExtentOrder       = ErrInvalidSparseMap
	ErrExtentOverlap     = ErrInvalidSparseMap
	ErrExtentOutOfBounds = ErrInvalidSparseMap
	ErrNegativeExtent    = ErrInvalidSparseMap
)

const (
	blockSize = 512

	// These match the limits used by archive/tar, preventing malformed
	// archives from causing unbounded allocation.
	maxSpecialFileSize   = 1 << 20
	maxSparseFileEntries = 1 << 20
)
