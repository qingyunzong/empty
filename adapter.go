// Package dirwalk traverses real directory trees concurrently with a
// bounded number of simultaneously open directory handles.
//
// Symlink following is optional. When enabled, cycles are detected by
// file identity (device + inode), not by path, so distinct paths that
// resolve to the same directory are traversed at most once.
//
// All filesystem access goes through the Adapter interface, so tests can
// inject fakes to verify link-cycle handling and handle-budget
// conservation.
package dirwalk

import "context"

// EntryType classifies a directory entry.
type EntryType int

const (
	TypeFile EntryType = iota
	TypeDir
	TypeSymlink
	TypeOther
)

func (t EntryType) String() string {
	switch t {
	case TypeFile:
		return "file"
	case TypeDir:
		return "dir"
	case TypeSymlink:
		return "symlink"
	default:
		return "other"
	}
}

// FileID identifies a file by device and inode. Two paths with the same
// FileID refer to the same underlying file.
type FileID struct {
	Dev uint64
	Ino uint64
}

// Entry describes one directory entry.
type Entry struct {
	Name string
	Type EntryType
	// ID is the identity of the entry itself (lstat semantics). It may be
	// zero for adapters that cannot provide it; only directories need a
	// meaningful ID for cycle detection.
	ID FileID
}

// Handle is an opaque open-directory handle returned by Adapter.OpenDir.
// Every successfully returned handle is eventually passed to Adapter.Close,
// including when the walk is canceled.
type Handle interface{}

// Adapter abstracts the filesystem so the walker can run against a real
// OS filesystem (OSFS) or an injected fake in tests.
//
// Implementations should honor ctx: a canceled context should make
// blocking operations return promptly so cancellation can close all
// handles quickly.
type Adapter interface {
	// OpenDir opens path for reading. The returned handle must be
	// released with Close.
	OpenDir(ctx context.Context, path string) (Handle, error)
	// ReadDir reads all entries of an open directory handle.
	ReadDir(ctx context.Context, h Handle) ([]Entry, error)
	// Stat resolves path, following symlinks, and describes the final
	// target. It is used to resolve symlink targets to their identity.
	Stat(ctx context.Context, path string) (Entry, error)
	// Close releases a handle obtained from OpenDir.
	Close(h Handle) error
}
