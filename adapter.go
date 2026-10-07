// Package testiso runs tests in isolated per-run directories. Each run
// copies only the files named by an input manifest, rejects paths that
// escape the source root (including symlinks that resolve outside it),
// and on failure keeps an evidence trail while removing non-evidence
// temporary items. Parallel runs of the same task are separated by
// monotonically increasing generation directories.
package testiso

import (
	"io"
	"os"
	"path/filepath"
)

// FileAdapter abstracts every filesystem effect the runner performs, so
// tests can inject controlled failures (see ControlledAdapter).
type FileAdapter interface {
	MkdirAll(path string, perm os.FileMode) error
	Mkdir(path string, perm os.FileMode) error
	RemoveAll(path string) error
	Rename(oldpath, newpath string) error
	Lstat(path string) (os.FileInfo, error)
	EvalSymlinks(path string) (string, error)
	CopyFile(src, dst string, perm os.FileMode) error
	WriteFile(path string, data []byte, perm os.FileMode) error
}

// OSAdapter is the production FileAdapter backed by the os package.
type OSAdapter struct{}

func (OSAdapter) MkdirAll(path string, perm os.FileMode) error { return os.MkdirAll(path, perm) }
func (OSAdapter) Mkdir(path string, perm os.FileMode) error    { return os.Mkdir(path, perm) }
func (OSAdapter) RemoveAll(path string) error                  { return os.RemoveAll(path) }
func (OSAdapter) Rename(oldpath, newpath string) error         { return os.Rename(oldpath, newpath) }
func (OSAdapter) Lstat(path string) (os.FileInfo, error)       { return os.Lstat(path) }
func (OSAdapter) EvalSymlinks(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
func (OSAdapter) WriteFile(path string, data []byte, perm os.FileMode) error {
	return os.WriteFile(path, data, perm)
}

// CopyFile copies src to dst, refusing to overwrite an existing dst.
func (OSAdapter) CopyFile(src, dst string, perm os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
