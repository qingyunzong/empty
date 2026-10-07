package testiso

import "os"

// ControlledAdapter wraps a base FileAdapter and injects faults at
// selected operations. It exists so tests (of this package and of its
// consumers) can verify failure handling, e.g. that a copy failure
// leaves evidence behind while temporary items are cleaned up.
//
// A nil Base falls back to OSAdapter.
type ControlledAdapter struct {
	Base FileAdapter

	// CopyFault, when non-nil, is consulted before every CopyFile. A
	// non-nil return aborts the copy with that error.
	CopyFault func(src, dst string) error
}

func (c ControlledAdapter) base() FileAdapter {
	if c.Base == nil {
		return OSAdapter{}
	}
	return c.Base
}

func (c ControlledAdapter) MkdirAll(path string, perm os.FileMode) error {
	return c.base().MkdirAll(path, perm)
}

func (c ControlledAdapter) Mkdir(path string, perm os.FileMode) error {
	return c.base().Mkdir(path, perm)
}

func (c ControlledAdapter) RemoveAll(path string) error {
	return c.base().RemoveAll(path)
}

func (c ControlledAdapter) Rename(oldpath, newpath string) error {
	return c.base().Rename(oldpath, newpath)
}

func (c ControlledAdapter) Lstat(path string) (os.FileInfo, error) {
	return c.base().Lstat(path)
}

func (c ControlledAdapter) EvalSymlinks(path string) (string, error) {
	return c.base().EvalSymlinks(path)
}

func (c ControlledAdapter) WriteFile(path string, data []byte, perm os.FileMode) error {
	return c.base().WriteFile(path, data, perm)
}

func (c ControlledAdapter) CopyFile(src, dst string, perm os.FileMode) error {
	if c.CopyFault != nil {
		if err := c.CopyFault(src, dst); err != nil {
			return err
		}
	}
	return c.base().CopyFile(src, dst, perm)
}
