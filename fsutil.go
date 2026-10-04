package materialpub

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// validateRunID rejects run IDs that could escape the runs directory.
func validateRunID(runID string) error {
	if runID == "" || runID == "." || runID == ".." {
		return fmt.Errorf("materialpub: invalid run ID %q", runID)
	}
	if strings.ContainsAny(runID, `/\`) || strings.ContainsRune(runID, 0) {
		return fmt.Errorf("materialpub: invalid run ID %q", runID)
	}
	return nil
}

// syncDir fsyncs a directory so renames and creations inside it are durable.
func syncDir(path string) error {
	d, err := os.Open(path)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// writeFileAtomic writes data to dir/name via a fsynced temporary file and an
// atomic rename, then fsyncs the directory. The final name never exposes
// partial content.
func writeFileAtomic(dir, name string, data []byte) error {
	tmp := filepath.Join(dir, name+tmpSuffix)
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, name)); err != nil {
		return err
	}
	return syncDir(dir)
}

// verifyFile re-reads dir/name from disk and checks size and digest.
func verifyFile(dir string, e FileEntry) error {
	data, err := os.ReadFile(filepath.Join(dir, e.Name))
	if err != nil {
		return err
	}
	if int64(len(data)) != e.Size || sha256Bytes(data) != e.SHA256 {
		return fmt.Errorf("materialpub: %s failed integrity verification", e.Name)
	}
	return nil
}

// removeStaleTemp deletes leftover *.tmp staging files from a crashed attempt.
func removeStaleTemp(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, ent := range entries {
		if strings.HasSuffix(ent.Name(), tmpSuffix) {
			if err := os.Remove(filepath.Join(dir, ent.Name())); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return err
			}
		}
	}
	return nil
}
