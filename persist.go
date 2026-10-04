package dualindex

import (
	"encoding/gob"
	"io"
	"os"
	"path/filepath"
)

// writeFileAtomic writes a file by encoding to a temporary sibling, fsyncing
// it, and atomically renaming it into place, then fsyncing the directory.
func writeFileAtomic(path string, write func(w io.Writer) error) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			f.Close()
			os.Remove(tmp)
		}
	}()
	if err := write(f); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	committed = true
	return syncDir(filepath.Dir(path))
}

func writeGobAtomic(path string, v any) error {
	return writeFileAtomic(path, func(w io.Writer) error {
		return gob.NewEncoder(w).Encode(v)
	})
}

func readGob(path string, v any) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return gob.NewDecoder(f).Decode(v)
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
