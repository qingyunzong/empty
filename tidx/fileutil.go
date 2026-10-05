package tidx

import (
	"os"
	"path/filepath"
)

// writeFileAtomic writes data to a temp file in the same directory and
// renames it over path, so a crash never leaves a half-written index.
func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".tidx-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, path)
}

func readFileAll(path string) ([]byte, error) {
	return os.ReadFile(path)
}
