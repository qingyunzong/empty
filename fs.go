package backupstore

import (
	"io"
	"os"
)

// Op identifies a mutating filesystem operation, used for fault injection.
type Op string

const (
	OpWrite   Op = "write"
	OpSync    Op = "sync"
	OpRename  Op = "rename"
	OpSyncDir Op = "syncdir"
)

// File is the subset of *os.File the store relies on.
type File interface {
	io.WriteCloser
	io.ReaderAt
	WriteAt(p []byte, off int64) (int, error)
	Sync() error
}

// FS abstracts the filesystem so tests can inject failures.
type FS interface {
	MkdirAll(path string, perm os.FileMode) error
	OpenFile(name string, flag int, perm os.FileMode) (File, error)
	Open(name string) (io.ReadCloser, error)
	Rename(oldpath, newpath string) error
	Remove(name string) error
	ReadDir(dir string) ([]os.DirEntry, error)
	SyncDir(dir string) error
}

type osFS struct{}

func (osFS) MkdirAll(path string, perm os.FileMode) error { return os.MkdirAll(path, perm) }

func (osFS) OpenFile(name string, flag int, perm os.FileMode) (File, error) {
	return os.OpenFile(name, flag, perm)
}

func (osFS) Open(name string) (io.ReadCloser, error) { return os.Open(name) }

func (osFS) Rename(oldpath, newpath string) error { return os.Rename(oldpath, newpath) }

func (osFS) Remove(name string) error { return os.Remove(name) }

func (osFS) ReadDir(dir string) ([]os.DirEntry, error) { return os.ReadDir(dir) }

func (osFS) SyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// FaultFS wraps an FS and calls Hook before every write, sync, rename and
// directory-sync. A non-nil hook error aborts the operation before it happens.
type FaultFS struct {
	FS   FS
	Hook func(op Op, path string) error
}

func (f FaultFS) inject(op Op, path string) error {
	if f.Hook == nil {
		return nil
	}
	return f.Hook(op, path)
}

func (f FaultFS) MkdirAll(path string, perm os.FileMode) error {
	return f.FS.MkdirAll(path, perm)
}

func (f FaultFS) OpenFile(name string, flag int, perm os.FileMode) (File, error) {
	inner, err := f.FS.OpenFile(name, flag, perm)
	if err != nil {
		return nil, err
	}
	return faultFile{File: inner, fs: f, path: name}, nil
}

func (f FaultFS) Open(name string) (io.ReadCloser, error) { return f.FS.Open(name) }

func (f FaultFS) Rename(oldpath, newpath string) error {
	if err := f.inject(OpRename, oldpath); err != nil {
		return err
	}
	return f.FS.Rename(oldpath, newpath)
}

func (f FaultFS) Remove(name string) error { return f.FS.Remove(name) }

func (f FaultFS) ReadDir(dir string) ([]os.DirEntry, error) { return f.FS.ReadDir(dir) }

func (f FaultFS) SyncDir(dir string) error {
	if err := f.inject(OpSyncDir, dir); err != nil {
		return err
	}
	return f.FS.SyncDir(dir)
}

type faultFile struct {
	File
	fs   FaultFS
	path string
}

func (f faultFile) Write(p []byte) (int, error) {
	if err := f.fs.inject(OpWrite, f.path); err != nil {
		return 0, err
	}
	return f.File.Write(p)
}

func (f faultFile) WriteAt(p []byte, off int64) (int, error) {
	if err := f.fs.inject(OpWrite, f.path); err != nil {
		return 0, err
	}
	return f.File.WriteAt(p, off)
}

func (f faultFile) Sync() error {
	if err := f.fs.inject(OpSync, f.path); err != nil {
		return err
	}
	return f.File.Sync()
}
