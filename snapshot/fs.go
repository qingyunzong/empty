// Package snapshot provides a directory snapshotter for file ingestion
// pipelines. It watches a remote directory tree (typically over SFTP),
// detects finished files, and only delivers a file after it has remained
// stable across a configurable number of complete scans.
//
// The package is dependency-free: remote access goes through the
// FileSystem interface, so it can be adapted to github.com/pkg/sftp,
// a local filesystem, or an in-memory fake for tests.
package snapshot

import (
	"context"
	"io"
	"time"
)

// FileID uniquely identifies a file's storage object when the server
// exposes it (e.g. device+inode on servers supporting stat extensions).
// Two paths with the same FileID are the same file (rename / hardlink).
type FileID struct {
	Dev uint64
	Ino uint64
}

// DirEntry describes one entry observed during a directory listing.
type DirEntry struct {
	// Path is the absolute path of the entry on the remote.
	Path string
	// Size in bytes.
	Size int64
	// ModTime is the remote modification time. Precision varies by
	// server; SFTP v3 commonly carries whole seconds only.
	ModTime time.Time
	// IsDir marks subdirectories.
	IsDir bool
	// ID is the storage identity when available.
	ID FileID
	// HasID reports whether ID is meaningful. When false, identity
	// falls back to path+size and content digest generations.
	HasID bool
}

// FileSystem abstracts the remote side. Implementations must be safe for
// sequential use by one Snapshotter.
type FileSystem interface {
	// List returns one page of entries directly inside dir.
	// Pass cursor "" for the first page; a non-empty next cursor means
	// more pages remain. Returning an empty page with a non-empty cursor
	// is allowed (servers may paginate unevenly).
	List(ctx context.Context, dir, cursor string) (entries []DirEntry, next string, err error)
	// Open opens path for reading, used to compute content digests.
	Open(ctx context.Context, path string) (io.ReadCloser, error)
}
