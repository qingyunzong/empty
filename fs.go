package runtool

import (
	"io"
	"io/fs"
	"os"
)

// FS abstracts every filesystem operation the runner needs. Tests wrap OSFS
// to inject controlled failures (for example, failing Create calls) and
// verify that failure handling keeps evidence and cleans temporaries.
type FS interface {
	Mkdir(path string, perm fs.FileMode) error
	MkdirAll(path string, perm fs.FileMode) error
	Open(path string) (io.ReadCloser, error)
	Create(path string) (io.WriteCloser, error)
	Lstat(path string) (fs.FileInfo, error)
	Readlink(path string) (string, error)
	ReadDir(path string) ([]fs.DirEntry, error)
	RemoveAll(path string) error
}

// OSFS implements FS against the host operating system.
type OSFS struct{}

func (OSFS) Mkdir(path string, perm fs.FileMode) error    { return os.Mkdir(path, perm) }
func (OSFS) MkdirAll(path string, perm fs.FileMode) error { return os.MkdirAll(path, perm) }
func (OSFS) Open(path string) (io.ReadCloser, error)      { return os.Open(path) }
func (OSFS) Create(path string) (io.WriteCloser, error)   { return os.Create(path) }
func (OSFS) Lstat(path string) (fs.FileInfo, error)       { return os.Lstat(path) }
func (OSFS) Readlink(path string) (string, error)         { return os.Readlink(path) }
func (OSFS) ReadDir(path string) ([]fs.DirEntry, error)   { return os.ReadDir(path) }
func (OSFS) RemoveAll(path string) error                  { return os.RemoveAll(path) }
