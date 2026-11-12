package dataeng_test

import (
	"os"
	"path/filepath"
)

func tempFilePath(content []byte) string {
	dir := os.Getenv("TMPDIR")
	if dir == "" {
		dir = os.TempDir()
	}
	f, err := os.CreateTemp(dir, "dataeng-host-*.raw")
	if err != nil {
		panic(err)
	}
	name := f.Name()
	if _, err := f.Write(content); err != nil {
		panic(err)
	}
	if err := f.Close(); err != nil {
		panic(err)
	}
	return filepath.Clean(name)
}
